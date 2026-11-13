const std = @import("std");
const Rules = @import("ignore.zig");

const Allocator = std.mem.Allocator;
const Dir = std.Io.Dir;
const Io = std.Io;
const assert = std.debug.assert;

const ignore_file = ".gitignore";
const ignore_bytes_max = 1024 * 1024;

const extensions: std.StaticStringMap(void) = .initComptime(.{
    .{"js"}, .{"jsx"}, .{"mjs"}, .{"cjs"},
    .{"ts"}, .{"tsx"}, .{"mts"}, .{"cts"},
});

pub const Files = struct {
    bytes: []const u8,
    ends: []const u32,

    pub fn path(files: Files, index: usize) []const u8 {
        const start = if (index == 0) 0 else files.ends[index - 1];
        return files.bytes[start..files.ends[index]];
    }
};

pub const Error = Allocator.Error || Io.Cancelable || error{Unreadable};

const Pending = struct {
    path_start: u32,
    rules: Rules.SetId,
};

const Entry = struct {
    name_start: u32,
    name_len: u32,
    is_directory: bool,
};

const Walker = struct {
    arena: Allocator,
    io: Io,
    root_len: usize,
    rules: Rules = .{},
    pending: std.ArrayList(Pending) = .empty,
    pending_bytes: std.ArrayList(u8) = .empty,
    path: std.ArrayList(u8) = .empty,
    entries: std.ArrayList(Entry) = .empty,
    names: std.ArrayList(u8) = .empty,
    bytes: std.ArrayList(u8) = .empty,
    ends: std.ArrayList(u32) = .empty,

    fn push(walker: *Walker, path: []const u8, rules: Rules.SetId) Allocator.Error!void {
        try walker.pending.append(walker.arena, .{
            .path_start = @intCast(walker.pending_bytes.items.len),
            .rules = rules,
        });
        try walker.pending_bytes.appendSlice(walker.arena, path);
    }

    fn pop(walker: *Walker) Allocator.Error!?Rules.SetId {
        const next = walker.pending.pop() orelse return null;
        try walker.enter(walker.pending_bytes.items[next.path_start..]);
        walker.pending_bytes.shrinkRetainingCapacity(next.path_start);
        return next.rules;
    }

    fn enter(walker: *Walker, directory: []const u8) Allocator.Error!void {
        assert(directory.len > 0);
        walker.path.clearRetainingCapacity();
        try walker.path.appendSlice(walker.arena, directory);
        if (directory[directory.len - 1] != '/') try walker.path.append(walker.arena, '/');
    }

    fn visit(walker: *Walker, inherited: Rules.SetId) Error!void {
        const directory_len = walker.path.items.len;
        const options: Dir.OpenOptions = .{ .iterate = true };
        var directory = Dir.openDirAbsolute(walker.io, walker.path.items, options) catch |err| {
            switch (err) {
                error.FileNotFound, error.NotDir => return,
                else => return unreadable(err),
            }
        };
        defer directory.close(walker.io);

        walker.entries.clearRetainingCapacity();
        walker.names.clearRetainingCapacity();
        var has_rules = false;
        var iterator = directory.iterateAssumeFirstIteration();
        while (iterator.next(walker.io) catch |err| return unreadable(err)) |entry| {
            const kind = if (entry.kind == .unknown)
                kindOf(walker.io, directory, entry.name) catch |err| return unreadable(err)
            else
                entry.kind;
            const is_directory = switch (kind) {
                .directory => true,
                .file => false,
                else => continue,
            };
            if (is_directory) {
                if (std.mem.eql(u8, entry.name, ".git")) continue;
                if (std.mem.eql(u8, entry.name, "node_modules")) continue;
            } else if (std.mem.eql(u8, entry.name, ignore_file)) {
                has_rules = true;
                continue;
            } else if (!isSource(entry.name)) continue;

            try walker.entries.append(walker.arena, .{
                .name_start = @intCast(walker.names.items.len),
                .name_len = @intCast(entry.name.len),
                .is_directory = is_directory,
            });
            try walker.names.appendSlice(walker.arena, entry.name);
        }

        const rules = if (has_rules) try walker.load(directory, inherited) else inherited;
        for (walker.entries.items) |entry| {
            walker.path.shrinkRetainingCapacity(directory_len);
            try walker.path.appendSlice(
                walker.arena,
                walker.names.items[entry.name_start..][0..entry.name_len],
            );
            const path = walker.path.items;
            const name_start: u32 = @intCast(directory_len);
            if (walker.rules.ignored(rules, path, name_start, entry.is_directory)) continue;
            if (entry.is_directory) {
                try walker.push(path, rules);
            } else {
                try walker.bytes.appendSlice(walker.arena, path[walker.root_len..]);
                try walker.ends.append(walker.arena, @intCast(walker.bytes.items.len));
            }
        }
    }

    fn load(walker: *Walker, directory: Dir, inherited: Rules.SetId) Error!Rules.SetId {
        const source = directory.readFileAlloc(
            walker.io,
            ignore_file,
            walker.arena,
            .limited(ignore_bytes_max),
        ) catch |err| switch (err) {
            error.FileNotFound => return inherited,
            else => return unreadable(err),
        };
        return walker.rules.add(walker.arena, inherited, @intCast(walker.path.items.len), source);
    }

    fn inherit(walker: *Walker, root: []const u8) Error!Rules.SetId {
        var top = root;
        while (!walker.exists(top, ".git")) top = std.fs.path.dirname(top) orelse return .none;

        var rules: Rules.SetId = .none;
        var len = top.len;
        while (len < root.len) {
            try walker.enter(root[0..len]);
            var directory = Dir.openDirAbsolute(walker.io, walker.path.items, .{}) catch |err| {
                return unreadable(err);
            };
            defer directory.close(walker.io);
            rules = try walker.load(directory, rules);
            len = std.mem.findScalarPos(u8, root, len + 1, '/') orelse root.len;
        }
        return rules;
    }

    fn exists(walker: *Walker, directory: []const u8, name: []const u8) bool {
        var buffer: [std.fs.max_path_bytes]u8 = undefined;
        const path = std.fmt.bufPrint(&buffer, "{s}/{s}", .{ directory, name }) catch return false;
        Dir.accessAbsolute(walker.io, path, .{}) catch return false;
        return true;
    }
};

pub fn walk(arena: Allocator, io: Io, root: []const u8) Error!Files {
    assert(std.fs.path.isAbsolute(root));
    const root_len = root.len + @intFromBool(root[root.len - 1] != '/');
    var walker: Walker = .{ .arena = arena, .io = io, .root_len = root_len };
    try walker.push(root, try walker.inherit(root));
    while (try walker.pop()) |rules| try walker.visit(rules);
    return .{ .bytes = walker.bytes.items, .ends = walker.ends.items };
}

pub fn admits(arena: Allocator, io: Io, root: []const u8, relative: []const u8) Error!bool {
    assert(std.fs.path.isAbsolute(root));
    if (relative.len == 0 or relative[0] == '/' or !isSource(std.fs.path.basename(relative))) {
        return false;
    }
    var walker: Walker = .{ .arena = arena, .io = io, .root_len = 0 };
    var rules = try walker.inherit(root);
    try walker.enter(root);
    const base_len = walker.path.items.len;

    var start: usize = 0;
    while (true) {
        const end = std.mem.findScalarPos(u8, relative, start, '/') orelse relative.len;
        const name = relative[start..end];
        const is_directory = end < relative.len;
        if (std.mem.eql(u8, name, "..") or std.mem.eql(u8, name, ".")) return false;
        if (is_directory and (std.mem.eql(u8, name, ".git") or std.mem.eql(u8, name, "node_modules"))) {
            return false;
        }

        walker.path.shrinkRetainingCapacity(base_len);
        try walker.path.appendSlice(arena, relative[0..start]);
        const directory_len: u32 = @intCast(walker.path.items.len);
        var directory = Dir.openDirAbsolute(io, walker.path.items, .{}) catch |err| switch (err) {
            error.FileNotFound, error.NotDir => return false,
            else => return unreadable(err),
        };
        defer directory.close(io);
        rules = try walker.load(directory, rules);

        try walker.path.appendSlice(arena, name);
        if (walker.rules.ignored(rules, walker.path.items, directory_len, is_directory)) return false;
        if (!is_directory) return true;
        start = end + 1;
    }
}

fn kindOf(io: Io, directory: Dir, name: []const u8) !std.Io.File.Kind {
    const stat = try directory.statFile(io, name, .{ .follow_symlinks = false });
    return stat.kind;
}

fn unreadable(err: anyerror) Error {
    return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.Canceled => error.Canceled,
        else => error.Unreadable,
    };
}

fn isSource(name: []const u8) bool {
    const dot = std.mem.findScalarLast(u8, name, '.') orelse return false;
    if (!extensions.has(name[dot + 1 ..])) return false;
    return !std.mem.endsWith(u8, name[0..dot], ".d");
}

test isSource {
    try std.testing.expect(isSource("app.tsx"));
    try std.testing.expect(isSource("server.mjs"));
    try std.testing.expect(isSource("a.b.ts"));
    try std.testing.expect(!isSource("types.d.ts"));
    try std.testing.expect(!isSource("types.d.mts"));
    try std.testing.expect(!isSource("styles.css"));
    try std.testing.expect(!isSource("Makefile"));
}
