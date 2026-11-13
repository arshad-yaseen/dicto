const std = @import("std");
const builtin = @import("builtin");
const extract = @import("extract.zig");
const walk = @import("walk.zig");

const Allocator = std.mem.Allocator;
const Io = std.Io;
const assert = std.debug.assert;

const source_bytes_max = 64 * 1024 * 1024;
const read_bytes_min = 64 * 1024;
const files_per_worker_min = 8;

pub const Error = walk.Error;

pub const Problem = struct {
    path: []const u8,
    line: u32,
    column: u32,
    kind: extract.Problem.Kind,
};

pub const File = struct {
    path: []const u8,
    messages: []const []const u8,
};

pub const Result = struct {
    files: []const File,
    problems: []const Problem,
};

const Job = struct {
    io: Io,
    root: Io.Dir,
    files: walk.Files,
    next: std.atomic.Value(u32) = .init(0),
    failed: std.atomic.Value(bool) = .init(false),
};

const Worker = struct {
    output: extract.Output,
    failure: ?Error = null,

    fn work(worker: *Worker, job: *Job) void {
        worker.run(job) catch |err| {
            worker.failure = err;
            job.failed.store(true, .monotonic);
        };
    }

    fn run(worker: *Worker, job: *Job) Error!void {
        var scratch: std.heap.ArenaAllocator = .init(std.heap.smp_allocator);
        defer scratch.deinit();
        var source: std.ArrayList(u8) = .empty;
        defer source.deinit(std.heap.smp_allocator);

        while (!job.failed.load(.monotonic)) {
            const index = job.next.fetchAdd(1, .monotonic);
            if (index >= job.files.ends.len) return;
            const path = job.files.path(index);
            if (!try read(job, path, &source)) continue;
            try extract.extract(scratch.allocator(), &worker.output, index, path, source.items);
            _ = scratch.reset(.retain_capacity);
        }
    }
};

fn read(job: *const Job, path: []const u8, source: *std.ArrayList(u8)) Error!bool {
    const options: Io.Dir.OpenFileOptions = .{ .allow_directory = builtin.os.tag != .windows };
    const file = job.root.openFile(job.io, path, options) catch |err| switch (err) {
        error.FileNotFound => return false,
        error.Canceled => return error.Canceled,
        else => return error.Unreadable,
    };
    defer file.close(job.io);

    source.clearRetainingCapacity();
    while (source.items.len <= source_bytes_max) {
        try source.ensureUnusedCapacity(std.heap.smp_allocator, read_bytes_min);
        const free = source.unusedCapacitySlice();
        const len = file.readPositional(job.io, &.{free}, source.items.len) catch |err| {
            return if (err == error.Canceled) error.Canceled else error.Unreadable;
        };
        source.items.len += len;
        // A regular file reads short only at its end.
        if (len < free.len) return true;
    }
    return error.Unreadable;
}

pub fn scan(arena: Allocator, io: Io, root: []const u8) Error!Result {
    const directory = try normalize(arena, root);
    return run(arena, io, directory, try walk.walk(arena, io, directory));
}

pub fn rescan(arena: Allocator, io: Io, root: []const u8, paths: []const []const u8) Error!Result {
    const directory = try normalize(arena, root);
    var bytes: std.ArrayList(u8) = .empty;
    var ends: std.ArrayList(u32) = .empty;
    for (paths) |path| {
        if (!try walk.admits(arena, io, directory, path)) continue;
        try bytes.appendSlice(arena, path);
        try ends.append(arena, @intCast(bytes.items.len));
    }
    return run(arena, io, directory, .{ .bytes = bytes.items, .ends = ends.items });
}

fn normalize(arena: Allocator, root: []const u8) Allocator.Error![]const u8 {
    const path = try arena.dupe(u8, root);
    if (builtin.os.tag == .windows) std.mem.replaceScalar(u8, path, '\\', '/');
    return path;
}

fn run(arena: Allocator, io: Io, root: []const u8, files: walk.Files) Error!Result {
    // Reading files stops scaling at about half the logical cores, where the kernel contends.
    const workers_max = @import("bench_options").workers;
    const workers_wanted = (files.ends.len + files_per_worker_min - 1) / files_per_worker_min;
    const workers = try arena.alloc(Worker, @min(workers_max, workers_wanted));
    for (workers) |*worker| worker.* = .{ .output = .{ .gpa = arena } };

    var directory = Io.Dir.openDirAbsolute(io, root, .{}) catch |err| {
        return if (err == error.Canceled) error.Canceled else error.Unreadable;
    };
    defer directory.close(io);
    var job: Job = .{ .io = io, .root = directory, .files = files };
    var group: Io.Group = .init;
    defer group.cancel(io);
    for (workers) |*worker| {
        group.concurrent(io, Worker.work, .{ worker, &job }) catch worker.work(&job);
    }
    try group.await(io);
    for (workers) |worker| if (worker.failure) |failure| return failure;

    return .{
        .files = try mergeFiles(arena, workers, files),
        .problems = try mergeProblems(arena, workers, files),
    };
}

fn mergeFiles(arena: Allocator, workers: []const Worker, files: walk.Files) Allocator.Error![]const File {
    var count: usize = 0;
    for (workers) |worker| count += worker.output.parsed.items.len;

    const merged = try arena.alloc(File, count);
    var filled: usize = 0;
    for (workers) |*worker| {
        const output = &worker.output;
        for (output.parsed.items) |parsed| {
            const messages = try arena.alloc([]const u8, parsed.messages_end - parsed.messages_start);
            for (messages, parsed.messages_start..) |*message, index| message.* = output.message(index);
            merged[filled] = .{ .path = files.path(parsed.file), .messages = messages };
            filled += 1;
        }
    }
    assert(filled == count);
    return merged;
}

fn mergeProblems(
    arena: Allocator,
    workers: []const Worker,
    files: walk.Files,
) Allocator.Error![]const Problem {
    var count: usize = 0;
    for (workers) |worker| count += worker.output.problems.items.len;

    const problems = try arena.alloc(Problem, count);
    var filled: usize = 0;
    for (workers) |worker| {
        for (worker.output.problems.items) |problem| {
            problems[filled] = .{
                .path = files.path(problem.file),
                .line = problem.line,
                .column = problem.column,
                .kind = problem.kind,
            };
            filled += 1;
        }
    }
    assert(filled == count);
    std.mem.sortUnstable(Problem, problems, {}, struct {
        fn lessThan(_: void, a: Problem, b: Problem) bool {
            return switch (std.mem.order(u8, a.path, b.path)) {
                .lt => true,
                .gt => false,
                .eq => if (a.line != b.line) a.line < b.line else a.column < b.column,
            };
        }
    }.lessThan);
    return problems;
}

test {
    _ = extract;
    _ = walk;
    _ = @import("ignore.zig");
}

test scan {
    const io = std.testing.io;
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const files = [_]struct { []const u8, []const u8 }{
        .{ ".git/HEAD", "ref: refs/heads/main\n" },
        .{ ".git/hooks/pre-commit.js", "import { t } from 'dicto'; t('In the repository');" },
        .{ ".gitignore", "dist\n/generated.ts\n" },
        .{ "src/app.tsx", "import { t } from 'dicto';\n<p>{t('Zebra')}{t('Apple')}</p>;\n" },
        .{ "src/nested/page.ts", "import { t } from 'dicto';\nt('Apple');\nt('Mango');\nt(1);\n" },
        .{ "src/nested/.gitignore", "*.draft.ts\n" },
        .{ "src/nested/idea.draft.ts", "import { t } from 'dicto'; t('Draft');" },
        .{ "src/plain.ts", "export const value = 1;\n" },
        .{ "src/types.d.ts", "import { t } from 'dicto'; t('Declaration');" },
        .{ "src/readme.md", "import { t } from 'dicto'; t('Markdown');" },
        .{ "generated.ts", "import { t } from 'dicto'; t('Generated');" },
        .{ "dist/app.js", "import { t } from 'dicto'; t('Built');" },
        .{ "node_modules/pkg/index.js", "import { t } from 'dicto'; t('Dependency');" },
    };
    for (files) |file| {
        if (std.fs.path.dirname(file[0])) |parent| try tmp.dir.createDirPath(io, parent);
        try tmp.dir.writeFile(io, .{ .sub_path = file[0], .data = file[1] });
    }

    const root = try tmp.dir.realPathFileAlloc(io, ".", arena.allocator());
    const result = try scan(arena.allocator(), io, root);

    try expectFiles(result, &.{
        .{ "src/app.tsx", &.{ "Zebra", "Apple" } },
        .{ "src/nested/page.ts", &.{ "Apple", "Mango" } },
    });
    try std.testing.expectEqual(1, result.problems.len);
    try std.testing.expectEqualStrings("src/nested/page.ts", result.problems[0].path);
    try std.testing.expectEqual(4, result.problems[0].line);
    try std.testing.expectEqual(3, result.problems[0].column);
    try std.testing.expectEqual(.call, result.problems[0].kind);

    const paths = [_][]const u8{
        "src/app.tsx",
        "src/nested/idea.draft.ts",
        "generated.ts",
        "dist/app.js",
        "node_modules/pkg/index.js",
        "src/types.d.ts",
        "src/readme.md",
        "src/gone.ts",
        "../outside.ts",
    };
    try expectFiles(try rescan(arena.allocator(), io, root, &paths), &.{
        .{ "src/app.tsx", &.{ "Zebra", "Apple" } },
    });
}

fn expectFiles(result: Result, expected: []const struct { []const u8, []const []const u8 }) !void {
    const files = try std.testing.allocator.dupe(File, result.files);
    defer std.testing.allocator.free(files);
    std.mem.sortUnstable(File, files, {}, struct {
        fn lessThan(_: void, a: File, b: File) bool {
            return std.mem.lessThan(u8, a.path, b.path);
        }
    }.lessThan);
    try std.testing.expectEqual(expected.len, files.len);
    for (expected, files) |want, got| {
        try std.testing.expectEqualStrings(want[0], got.path);
        try std.testing.expectEqual(want[1].len, got.messages.len);
        for (want[1], got.messages) |message, actual| try std.testing.expectEqualStrings(message, actual);
    }
}
