const std = @import("std");

pub fn build(b: *std.Build) void {
    const host = b.graph.host.result;
    const all = b.step("native", "Build the Node-API addon for every platform the package ships");
    for (platforms) |platform| {
        const addon_file = addAddon(b, platform);
        all.dependOn(addon_file);
        if (platform.runsOn(host)) b.getInstallStep().dependOn(addon_file);
    }

    const yuku = b.dependency("yuku", .{ .target = b.graph.host, .optimize = .safe });
    const tests = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("src/scan.zig"),
        .target = b.graph.host,
        .optimize = .safe,
        .imports = &.{.{ .name = "parser", .module = yuku.module("parser") }},
    }) });
    b.step("test", "Run the tests").dependOn(&b.addRunArtifact(tests).step);
}

const Platform = struct {
    name: []const u8,
    query: std.Target.Query,

    fn runsOn(platform: Platform, host: std.Target) bool {
        if (platform.query.os_tag != host.os.tag) return false;
        if (platform.query.cpu_arch != host.cpu.arch) return false;
        return host.os.tag != .linux or platform.query.abi.?.isMusl() == host.abi.isMusl();
    }
};

const platforms = [_]Platform{
    .{ .name = "darwin-arm64", .query = .{
        .cpu_arch = .aarch64,
        .os_tag = .macos,
        .os_version_min = .{ .semver = .{ .major = 11, .minor = 0, .patch = 0 } },
    } },
    .{ .name = "darwin-x64", .query = .{
        .cpu_arch = .x86_64,
        .os_tag = .macos,
        .os_version_min = .{ .semver = .{ .major = 10, .minor = 15, .patch = 0 } },
    } },
    .{ .name = "linux-arm64-gnu", .query = linux(.aarch64, .gnu) },
    .{ .name = "linux-arm64-musl", .query = linux(.aarch64, .musl) },
    .{ .name = "linux-x64-gnu", .query = linux(.x86_64, .gnu) },
    .{ .name = "linux-x64-musl", .query = linux(.x86_64, .musl) },
    .{ .name = "win32-arm64", .query = .{ .cpu_arch = .aarch64, .os_tag = .windows, .abi = .gnu } },
    .{ .name = "win32-x64", .query = .{ .cpu_arch = .x86_64, .os_tag = .windows, .abi = .gnu } },
};

fn linux(arch: std.Target.Cpu.Arch, abi: std.Target.Abi) std.Target.Query {
    return .{ .cpu_arch = arch, .os_tag = .linux, .abi = abi };
}

fn addAddon(b: *std.Build, platform: Platform) *std.Build.Step {
    var query = platform.query;
    query.cpu_model = .baseline;
    const target = b.resolveTargetQuery(query);
    const yuku = b.dependency("yuku", .{ .target = target, .optimize = .fast });

    const bench_options = b.addOptions();
    if (workers == null) workers = b.option(usize, "workers", "workers") orelse 4;
    bench_options.addOption(usize, "workers", workers.?);
    const addon = b.addLibrary(.{
        .name = "dicto",
        .linkage = .dynamic,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/addon.zig"),
            .target = target,
            .optimize = .fast,
            .strip = true,
            // Worker threads need the C library's thread-local storage inside a host that has one.
            .link_libc = query.os_tag == .linux,
            .imports = &.{
                .{ .name = "parser", .module = yuku.module("parser") },
                .{ .name = "bench_options", .module = bench_options.createModule() },
            },
        }),
    });
    addon.linker_allow_shlib_undefined = true;

    const files = b.addUpdateSourceFiles();
    files.addCopyFileToSource(addon.getEmittedBin(), b.fmt("npm/native/{s}/dicto.node", .{platform.name}));
    return &files.step;
}

var workers: ?usize = null;
