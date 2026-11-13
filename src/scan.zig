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

pub const Result = struct {
    messages: []const []const u8,
    problems: []const Problem,
    complete: bool,
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
    const path = try arena.dupe(u8, root);
    if (builtin.os.tag == .windows) std.mem.replaceScalar(u8, path, '\\', '/');
    const files = try walk.walk(arena, io, path);

    // Reading files stops scaling at about half the logical cores, where the kernel contends.
    const workers_max = @max(1, (std.Thread.getCpuCount() catch 1) / 2);
    const workers_wanted = (files.ends.len + files_per_worker_min - 1) / files_per_worker_min;
    const workers = try arena.alloc(Worker, @min(workers_max, workers_wanted));
    for (workers) |*worker| worker.* = .{ .output = .{ .gpa = arena } };

    var directory = Io.Dir.openDirAbsolute(io, path, .{}) catch |err| {
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
        .messages = try mergeMessages(arena, workers),
        .problems = try mergeProblems(arena, workers, files),
        .complete = for (workers) |worker| {
            if (!worker.output.complete) break false;
        } else true,
    };
}

fn mergeMessages(arena: Allocator, workers: []const Worker) Allocator.Error![]const []const u8 {
    var count: usize = 0;
    for (workers) |worker| count += worker.output.ends.items.len;

    const messages = try arena.alloc([]const u8, count);
    var filled: usize = 0;
    for (workers) |*worker| {
        for (0..worker.output.ends.items.len) |index| {
            messages[filled] = worker.output.message(index);
            filled += 1;
        }
    }
    assert(filled == count);
    std.mem.sortUnstable([]const u8, messages, {}, struct {
        fn lessThan(_: void, a: []const u8, b: []const u8) bool {
            return std.mem.lessThan(u8, a, b);
        }
    }.lessThan);

    var unique: usize = 0;
    for (messages) |message| {
        if (unique > 0 and std.mem.eql(u8, messages[unique - 1], message)) continue;
        messages[unique] = message;
        unique += 1;
    }
    return messages[0..unique];
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

    try std.testing.expect(result.complete);
    try std.testing.expectEqual(3, result.messages.len);
    try std.testing.expectEqualStrings("Apple", result.messages[0]);
    try std.testing.expectEqualStrings("Mango", result.messages[1]);
    try std.testing.expectEqualStrings("Zebra", result.messages[2]);
    try std.testing.expectEqual(1, result.problems.len);
    try std.testing.expectEqualStrings("src/nested/page.ts", result.problems[0].path);
    try std.testing.expectEqual(4, result.problems[0].line);
    try std.testing.expectEqual(3, result.problems[0].column);
    try std.testing.expectEqual(.call, result.problems[0].kind);
}
