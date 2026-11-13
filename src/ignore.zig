const std = @import("std");

const Allocator = std.mem.Allocator;
const assert = std.debug.assert;

const Rules = @This();

patterns: std.MultiArrayList(Pattern) = .empty,
sets: std.ArrayList(Set) = .empty,
bytes: std.ArrayList(u8) = .empty,

pub const SetId = enum(u32) { none = std.math.maxInt(u32), _ };

const Set = struct {
    parent: SetId,
    base_len: u32,
    patterns_start: u32,
    patterns_len: u32,
};

const Pattern = struct {
    start: u32,
    len: u32,
    flags: Flags,

    const Flags = packed struct(u8) {
        negated: bool,
        directory_only: bool,
        anchored: bool,
        literal: bool,
        _: u4 = 0,
    };
};

pub fn add(
    rules: *Rules,
    gpa: Allocator,
    parent: SetId,
    base_len: u32,
    source: []const u8,
) Allocator.Error!SetId {
    const patterns_start: u32 = @intCast(rules.patterns.len);
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |line| try rules.addLine(gpa, line);

    const id: SetId = @fromBackingInt(@as(u32, @intCast(rules.sets.items.len)));
    try rules.sets.append(gpa, .{
        .parent = parent,
        .base_len = base_len,
        .patterns_start = patterns_start,
        .patterns_len = @as(u32, @intCast(rules.patterns.len)) - patterns_start,
    });
    return id;
}

fn addLine(rules: *Rules, gpa: Allocator, line: []const u8) Allocator.Error!void {
    var text = trimTrailing(line);
    if (text.len == 0 or text[0] == '#') return;

    const negated = text[0] == '!';
    if (negated) text = text[1..];

    const directory_only = text.len > 0 and text[text.len - 1] == '/';
    if (directory_only) text = text[0 .. text.len - 1];

    const anchored = std.mem.findScalar(u8, text, '/') != null;
    if (text.len > 0 and text[0] == '/') text = text[1..];
    if (text.len == 0) return;

    try rules.patterns.append(gpa, .{
        .start = @intCast(rules.bytes.items.len),
        .len = @intCast(text.len),
        .flags = .{
            .negated = negated,
            .directory_only = directory_only,
            .anchored = anchored,
            .literal = std.mem.findAny(u8, text, "*?[\\") == null,
        },
    });
    try rules.bytes.appendSlice(gpa, text);
}

fn trimTrailing(line: []const u8) []const u8 {
    var end = line.len;
    if (end > 0 and line[end - 1] == '\r') end -= 1;
    while (end > 0 and line[end - 1] == ' ') {
        if (end > 1 and line[end - 2] == '\\') break;
        end -= 1;
    }
    return line[0..end];
}

pub fn ignored(
    rules: *const Rules,
    set: SetId,
    path: []const u8,
    name_start: u32,
    is_directory: bool,
) bool {
    assert(name_start < path.len);
    const slice = rules.patterns.slice();
    const starts = slice.items(.start);
    const lens = slice.items(.len);
    const flags = slice.items(.flags);

    var id = set;
    while (id != .none) {
        const current = rules.sets.items[@backingInt(id)];
        assert(current.base_len <= name_start);
        var index = current.patterns_start + current.patterns_len;
        while (index > current.patterns_start) {
            index -= 1;
            if (flags[index].directory_only and !is_directory) continue;
            const text = rules.bytes.items[starts[index]..][0..lens[index]];
            const subject = path[if (flags[index].anchored) current.base_len else name_start..];
            const matched = if (flags[index].literal)
                std.mem.eql(u8, text, subject)
            else
                matches(text, subject);
            if (matched) return !flags[index].negated;
        }
        id = current.parent;
    }
    return false;
}

const Backtrack = struct { pattern: usize, text: usize };

fn matches(pattern: []const u8, text: []const u8) bool {
    var p: usize = 0;
    var t: usize = 0;
    var star: ?Backtrack = null;
    var globstar: ?Backtrack = null;

    while (true) {
        if (p == pattern.len and t == text.len) return true;

        if (p < pattern.len) advance: {
            switch (pattern[p]) {
                '*' => {
                    if (!isGlobstar(pattern, p)) {
                        p += 1;
                        star = .{ .pattern = p, .text = t };
                        continue;
                    }
                    if (p + 2 == pattern.len) return true;
                    p += 3;
                    globstar = .{ .pattern = p, .text = t };
                    star = null;
                    continue;
                },
                '?' => {
                    if (t == text.len or text[t] == '/') break :advance;
                    p += 1;
                },
                '[' => {
                    if (t == text.len or text[t] == '/') break :advance;
                    p = classEnd(pattern, p, text[t]) orelse break :advance;
                },
                '\\' => {
                    if (p + 1 == pattern.len) break :advance;
                    if (t == text.len or text[t] != pattern[p + 1]) break :advance;
                    p += 2;
                },
                else => |char| {
                    if (t == text.len or text[t] != char) break :advance;
                    p += 1;
                },
            }
            t += 1;
            continue;
        }

        if (star) |*retry| {
            if (retry.text < text.len and text[retry.text] != '/') {
                retry.text += 1;
                p = retry.pattern;
                t = retry.text;
                continue;
            }
        }
        if (globstar) |*retry| {
            if (std.mem.findScalarPos(u8, text, retry.text, '/')) |slash| {
                retry.text = slash + 1;
                p = retry.pattern;
                t = retry.text;
                star = null;
                continue;
            }
        }
        return false;
    }
}

fn isGlobstar(pattern: []const u8, at: usize) bool {
    assert(pattern[at] == '*');
    if (at + 1 == pattern.len or pattern[at + 1] != '*') return false;
    if (at > 0 and pattern[at - 1] != '/') return false;
    return at + 2 == pattern.len or pattern[at + 2] == '/';
}

fn classEnd(pattern: []const u8, open: usize, char: u8) ?usize {
    assert(pattern[open] == '[');
    var index = open + 1;
    const negated = index < pattern.len and (pattern[index] == '!' or pattern[index] == '^');
    if (negated) index += 1;

    var found = false;
    const first = index;
    while (index < pattern.len) {
        if (pattern[index] == ']' and index > first) {
            return if (found != negated) index + 1 else null;
        }
        const low = memberAt(pattern, &index) orelse return null;
        var high = low;
        if (index + 1 < pattern.len and pattern[index] == '-' and pattern[index + 1] != ']') {
            index += 1;
            high = memberAt(pattern, &index) orelse return null;
        }
        if (low <= char and char <= high) found = true;
    }
    return null;
}

fn memberAt(pattern: []const u8, index: *usize) ?u8 {
    if (pattern[index.*] == '\\') index.* += 1;
    if (index.* == pattern.len) return null;
    defer index.* += 1;
    return pattern[index.*];
}

test matches {
    const cases = [_]struct { []const u8, []const u8, bool }{
        .{ "*.log", "debug.log", true },
        .{ "*.log", ".log", true },
        .{ "*.log", "debug.logs", false },
        .{ "*", "a/b", false },
        .{ "a*c", "abbbc", true },
        .{ "a*c", "ab/c", false },
        .{ "a?c", "abc", true },
        .{ "a?c", "a/c", false },
        .{ "a**c", "abbc", true },
        .{ "**/dist", "dist", true },
        .{ "**/dist", "a/b/dist", true },
        .{ "**/dist", "a/distant", false },
        .{ "a/**/b", "a/b", true },
        .{ "a/**/b", "a/x/y/b", true },
        .{ "a/**/b", "a/x/yb", false },
        .{ "a/**", "a/x/y", true },
        .{ "a/**", "a", false },
        .{ "a/*/c", "a/b/c", true },
        .{ "a/*/c", "a/b/b/c", false },
        .{ "**/a/*.js", "x/y/a/z.js", true },
        .{ "**/a/*.js", "x/y/a/b/z.js", false },
        .{ "[abc].js", "b.js", true },
        .{ "[a-c].js", "d.js", false },
        .{ "[!a-c].js", "d.js", true },
        .{ "[]a].js", "].js", true },
        .{ "[a", "a", false },
        .{ "\\*.js", "*.js", true },
        .{ "\\*.js", "a.js", false },
    };
    for (cases) |case| {
        errdefer std.debug.print("{s} against {s}\n", .{ case[0], case[1] });
        try std.testing.expectEqual(case[2], matches(case[0], case[1]));
    }
}

test ignored {
    const gpa = std.testing.allocator;
    var rules: Rules = .{};
    defer {
        rules.patterns.deinit(gpa);
        rules.sets.deinit(gpa);
        rules.bytes.deinit(gpa);
    }

    const outer = try rules.add(gpa, .none, "/repo/".len,
        \\# build output
        \\dist
        \\/top.js
        \\*.gen.ts
        \\logs/
        \\apps/web/out
        \\!keep.gen.ts
        \\trailing.js
    );
    const inner = try rules.add(gpa, outer, "/repo/apps/".len,
        \\!dist
        \\/local.ts
    );

    const cases = [_]struct { SetId, []const u8, bool, bool }{
        .{ outer, "/repo/dist", true, true },
        .{ outer, "/repo/src/dist", true, true },
        .{ outer, "/repo/top.js", false, true },
        .{ outer, "/repo/src/top.js", false, false },
        .{ outer, "/repo/src/a.gen.ts", false, true },
        .{ outer, "/repo/src/keep.gen.ts", false, false },
        .{ outer, "/repo/logs", true, true },
        .{ outer, "/repo/logs", false, false },
        .{ outer, "/repo/apps/web/out", true, true },
        .{ outer, "/repo/web/out", true, false },
        .{ outer, "/repo/trailing.js", false, true },
        .{ inner, "/repo/apps/dist", true, false },
        .{ inner, "/repo/apps/local.ts", false, true },
        .{ inner, "/repo/apps/web/local.ts", false, false },
        .{ inner, "/repo/apps/web/a.gen.ts", false, true },
    };
    for (cases) |case| {
        errdefer std.debug.print("{s}\n", .{case[1]});
        const name_start: u32 = @intCast(std.mem.findScalarLast(u8, case[1], '/').? + 1);
        try std.testing.expectEqual(case[3], rules.ignored(case[0], case[1], name_start, case[2]));
    }
}
