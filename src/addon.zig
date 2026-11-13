const std = @import("std");
const builtin = @import("builtin");
const scanner = @import("scan.zig");

const Allocator = std.mem.Allocator;

const Error = scanner.Error || error{NodeApi};

const Env = *opaque {};
const Value = *opaque {};
const CallbackInfo = *opaque {};
const Status = enum(c_int) { ok = 0, _ };
const Callback = *const fn (Env, CallbackInfo) callconv(.c) ?Value;

const Api = struct {
    napi_create_function: *const fn (
        Env,
        [*]const u8,
        usize,
        Callback,
        ?*anyopaque,
        *Value,
    ) callconv(.c) Status,
    napi_get_cb_info: *const fn (
        Env,
        CallbackInfo,
        *usize,
        [*]Value,
        ?*Value,
        ?*?*anyopaque,
    ) callconv(.c) Status,
    napi_get_value_string_utf8: *const fn (Env, Value, ?[*]u8, usize, *usize) callconv(.c) Status,
    napi_create_string_utf8: *const fn (Env, [*]const u8, usize, *Value) callconv(.c) Status,
    napi_create_uint32: *const fn (Env, u32, *Value) callconv(.c) Status,
    napi_get_array_length: *const fn (Env, Value, *u32) callconv(.c) Status,
    napi_get_element: *const fn (Env, Value, u32, *Value) callconv(.c) Status,
    napi_create_object: *const fn (Env, *Value) callconv(.c) Status,
    napi_create_array_with_length: *const fn (Env, usize, *Value) callconv(.c) Status,
    napi_set_element: *const fn (Env, Value, u32, Value) callconv(.c) Status,
    napi_set_named_property: *const fn (Env, Value, [*:0]const u8, Value) callconv(.c) Status,
    napi_throw_error: *const fn (Env, ?[*:0]const u8, [*:0]const u8) callconv(.c) Status,
};

const windows = struct {
    const HMODULE = std.os.windows.HMODULE;

    extern "kernel32" fn GetModuleHandleW(name: ?[*:0]const u16) callconv(.winapi) ?HMODULE;
    extern "kernel32" fn GetProcAddress(
        module: HMODULE,
        name: [*:0]const u8,
    ) callconv(.winapi) ?*const anyopaque;
};

fn bindApi() error{NodeApi}!Api {
    const fields = @typeInfo(Api).@"struct";
    var api: Api = undefined;
    if (builtin.os.tag != .windows) {
        inline for (fields.field_names, fields.field_types) |name, Function| {
            @field(api, name) = @extern(Function, .{ .name = name });
        }
        return api;
    }
    const host = windows.GetModuleHandleW(null) orelse return error.NodeApi;
    inline for (fields.field_names) |name| {
        const address = windows.GetProcAddress(host, name) orelse return error.NodeApi;
        @field(api, name) = @ptrCast(@alignCast(address));
    }
    return api;
}

export fn napi_register_module_v1(env: Env, exports: Value) ?Value {
    const api = bindApi() catch return null;
    define(&api, env, exports, "scan", Call.scan) catch return null;
    define(&api, env, exports, "rescan", Call.rescan) catch return null;
    return exports;
}

fn define(
    api: *const Api,
    env: Env,
    exports: Value,
    comptime name: [:0]const u8,
    comptime run: fn (Call, []const Value) Error!Value,
) error{NodeApi}!void {
    var function: Value = undefined;
    try check(api.napi_create_function(env, name.ptr, name.len, callback(run), null, &function));
    try check(api.napi_set_named_property(env, exports, name, function));
}

fn check(status: Status) error{NodeApi}!void {
    if (status != .ok) return error.NodeApi;
}

fn callback(comptime run: fn (Call, []const Value) Error!Value) Callback {
    return struct {
        fn call(env: Env, info: CallbackInfo) callconv(.c) ?Value {
            const api = bindApi() catch return null;
            var arena: std.heap.ArenaAllocator = .init(std.heap.smp_allocator);
            defer arena.deinit();

            const context: Call = .{ .api = &api, .env = env, .arena = arena.allocator() };
            var argc: usize = 2;
            var argv: [2]Value = undefined;
            const status = api.napi_get_cb_info(env, info, &argc, &argv, null, null);
            return run(context, if (status == .ok) argv[0..argc] else &.{}) catch |err| {
                _ = api.napi_throw_error(env, null, switch (err) {
                    error.OutOfMemory => "dicto: out of memory",
                    error.Unreadable => "dicto: a file or directory could not be read",
                    error.Canceled => "dicto: the scan was canceled",
                    error.NodeApi => "dicto: expected an absolute root and a list of paths",
                });
                return null;
            };
        }
    }.call;
}

const Call = struct {
    api: *const Api,
    env: Env,
    arena: Allocator,

    fn scan(call: Call, args: []const Value) Error!Value {
        if (args.len < 1) return error.NodeApi;
        var threaded: std.Io.Threaded = .init(std.heap.smp_allocator, .{});
        defer threaded.deinit();
        return call.result(try scanner.scan(call.arena, threaded.io(), try call.root(args[0])));
    }

    fn rescan(call: Call, args: []const Value) Error!Value {
        if (args.len < 2) return error.NodeApi;
        const directory = try call.root(args[0]);
        var len: u32 = undefined;
        try check(call.api.napi_get_array_length(call.env, args[1], &len));
        const paths = try call.arena.alloc([]const u8, len);
        for (paths, 0..) |*path, index| {
            var element: Value = undefined;
            try check(call.api.napi_get_element(call.env, args[1], @intCast(index), &element));
            path.* = try call.text(element);
        }
        var threaded: std.Io.Threaded = .init(std.heap.smp_allocator, .{});
        defer threaded.deinit();
        return call.result(try scanner.rescan(call.arena, threaded.io(), directory, paths));
    }

    fn root(call: Call, value: Value) Error![]const u8 {
        const path = try call.text(value);
        return if (std.fs.path.isAbsolute(path)) path else error.NodeApi;
    }

    fn result(call: Call, scanned: scanner.Result) Error!Value {
        const files = try call.array(scanned.files.len);
        for (scanned.files, 0..) |file, index| {
            const messages = try call.array(file.messages.len);
            for (file.messages, 0..) |message, at| {
                try call.setElement(messages, at, try call.string(message));
            }
            const entry = try call.object();
            try call.set(entry, "path", try call.string(file.path));
            try call.set(entry, "messages", messages);
            try call.setElement(files, index, entry);
        }
        const problems = try call.array(scanned.problems.len);
        for (scanned.problems, 0..) |problem, index| {
            const entry = try call.object();
            try call.set(entry, "path", try call.string(problem.path));
            try call.set(entry, "line", try call.number(problem.line));
            try call.set(entry, "column", try call.number(problem.column));
            try call.set(entry, "kind", try call.string(@tagName(problem.kind)));
            try call.setElement(problems, index, entry);
        }
        const value = try call.object();
        try call.set(value, "files", files);
        try call.set(value, "problems", problems);
        return value;
    }

    fn text(call: Call, value: Value) Error![]const u8 {
        var len: usize = undefined;
        try check(call.api.napi_get_value_string_utf8(call.env, value, null, 0, &len));
        const bytes = try call.arena.alloc(u8, len + 1);
        try check(call.api.napi_get_value_string_utf8(call.env, value, bytes.ptr, bytes.len, &len));
        return bytes[0..len];
    }

    fn string(call: Call, bytes: []const u8) Error!Value {
        var value: Value = undefined;
        try check(call.api.napi_create_string_utf8(call.env, bytes.ptr, bytes.len, &value));
        return value;
    }

    fn number(call: Call, int: u32) Error!Value {
        var value: Value = undefined;
        try check(call.api.napi_create_uint32(call.env, int, &value));
        return value;
    }

    fn object(call: Call) Error!Value {
        var value: Value = undefined;
        try check(call.api.napi_create_object(call.env, &value));
        return value;
    }

    fn array(call: Call, len: usize) Error!Value {
        var value: Value = undefined;
        try check(call.api.napi_create_array_with_length(call.env, len, &value));
        return value;
    }

    fn set(call: Call, target: Value, comptime name: [:0]const u8, value: Value) Error!void {
        try check(call.api.napi_set_named_property(call.env, target, name.ptr, value));
    }

    fn setElement(call: Call, target: Value, index: usize, value: Value) Error!void {
        try check(call.api.napi_set_element(call.env, target, @intCast(index), value));
    }
};
