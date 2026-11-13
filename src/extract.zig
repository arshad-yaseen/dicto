const std = @import("std");
const parser = @import("parser");

const Allocator = std.mem.Allocator;
const ast = parser.ast;
const Semantic = parser.semantic.Semantic;
const SymbolId = parser.semantic.SymbolId;
const assert = std.debug.assert;

pub const package = "dicto";
const function = "t";

pub const Problem = struct {
    file: u32,
    line: u32,
    column: u32,
    kind: Kind,

    pub const Kind = enum(u8) {
        syntax,
        call,
        import,
    };
};

pub const Parsed = struct {
    file: u32,
    messages_start: u32,
    messages_end: u32,
};

pub const Output = struct {
    gpa: Allocator,
    bytes: std.ArrayList(u8) = .empty,
    ends: std.ArrayList(u32) = .empty,
    parsed: std.ArrayList(Parsed) = .empty,
    problems: std.ArrayList(Problem) = .empty,

    pub fn message(output: *const Output, index: usize) []const u8 {
        const start = if (index == 0) 0 else output.ends.items[index - 1];
        return output.bytes.items[start..output.ends.items[index]];
    }

    fn report(
        output: *Output,
        file: u32,
        source: []const u8,
        kind: Problem.Kind,
        offset: u32,
    ) Allocator.Error!void {
        const before = source[0..offset];
        const line_start = if (std.mem.findScalarLast(u8, before, '\n')) |end| end + 1 else 0;
        const line = before[line_start..];
        try output.problems.append(output.gpa, .{
            .file = file,
            .line = @intCast(std.mem.countScalar(u8, before, '\n') + 1),
            .column = @intCast((std.unicode.utf8CountCodepoints(line) catch line.len) + 1),
            .kind = kind,
        });
    }
};

pub fn extract(
    scratch: Allocator,
    output: *Output,
    file: u32,
    path: []const u8,
    source: []const u8,
) Allocator.Error!void {
    if (!mentionsPackage(source)) return;

    var tree = try parser.parse(scratch, source, .{
        .source_type = .fromPath(path),
        .lang = switch (ast.Lang.fromPath(path)) {
            .js => .jsx,
            else => |lang| lang,
        },
        .preserve_parens = false,
        .comments = .none,
    });
    defer tree.deinit();

    for (tree.diagnostics.items) |diagnostic| {
        if (diagnostic.severity != .@"error") continue;
        return output.report(file, source, .syntax, diagnostic.span.start);
    }

    const semantic = try parser.semantic.analyze(&tree, .{ .check = false });
    const records = try parser.semantic.module_record.collect(&tree, &semantic);
    const module: Module = .{
        .output = output,
        .file = file,
        .tree = &tree,
        .semantic = &semantic,
    };
    const messages_start: u32 = @intCast(output.ends.items.len);
    try module.read(records);
    try output.parsed.append(output.gpa, .{
        .file = file,
        .messages_start = messages_start,
        .messages_end = @intCast(output.ends.items.len),
    });
}

fn mentionsPackage(source: []const u8) bool {
    var from: usize = 0;
    while (std.mem.findPos(u8, source, from, package)) |start| : (from = start + 1) {
        const end = start + package.len;
        if (start == 0 or end == source.len) continue;
        const quote = source[start - 1];
        if (quote != source[end]) continue;
        if (quote == '"' or quote == '\'' or quote == '`') return true;
    }
    return false;
}

const Module = struct {
    output: *Output,
    file: u32,
    tree: *const ast.Tree,
    semantic: *const Semantic,

    fn read(module: Module, records: parser.semantic.module_record.Records) Allocator.Error!void {
        const tree = module.tree;
        for (records.imports) |import| {
            if (!std.mem.eql(u8, tree.string(import.specifier), package)) continue;
            switch (import.kind) {
                .named => {
                    if (import.type_only) continue;
                    if (!std.mem.eql(u8, tree.string(import.name), function)) continue;
                    try module.uses(import.symbol);
                },
                .side_effect, .augmentation => {},
                .namespace, .import_equals, .dynamic, .require => {
                    try module.problem(.import, import.node);
                },
            }
        }
        for (records.exports) |exported| {
            if (!std.mem.eql(u8, tree.string(exported.specifier), package)) continue;
            const forwards = switch (exported.kind) {
                .re_export => std.mem.eql(u8, tree.string(exported.from_name), function),
                .namespace, .star => true,
                .named, .equals, .global => false,
            };
            if (forwards and !exported.type_only) try module.problem(.import, exported.node);
        }
    }

    fn uses(module: Module, symbol: SymbolId) Allocator.Error!void {
        assert(symbol != .none);
        for (module.semantic.uses(symbol)) |id| {
            const reference = module.semantic.reference(id);
            if (reference.flags.type_position) continue;
            try module.call(reference.node);
        }
    }

    fn call(module: Module, callee: ast.NodeIndex) Allocator.Error!void {
        const tree = module.tree;
        const parent = module.semantic.parentOf(callee) orelse return module.problem(.call, callee);
        const expression = switch (tree.data(parent)) {
            .call_expression => |expression| expression,
            else => return module.problem(.call, callee),
        };
        if (expression.callee != callee) return module.problem(.call, callee);
        const arguments = tree.extra(expression.arguments);
        if (arguments.len == 0) return module.problem(.call, callee);

        const message = module.literal(arguments[0]) orelse "";
        if (message.len == 0) return module.problem(.call, arguments[0]);

        const output = module.output;
        try output.bytes.appendSlice(output.gpa, message);
        try output.ends.append(output.gpa, @intCast(output.bytes.items.len));
    }

    fn literal(module: Module, node: ast.NodeIndex) ?[]const u8 {
        const tree = module.tree;
        switch (tree.data(node)) {
            .string_literal => |string| return tree.string(string.value),
            .template_literal => |template| {
                if (template.expressions.len > 0) return null;
                const quasi = tree.data(tree.extra(template.quasis)[0]).template_element;
                return tree.string(quasi.cooked);
            },
            else => return null,
        }
    }

    fn problem(module: Module, kind: Problem.Kind, node: ast.NodeIndex) Allocator.Error!void {
        const offset = module.tree.span(node).start;
        return module.output.report(module.file, module.tree.source, kind, offset);
    }
};

const Expected = struct {
    messages: []const []const u8 = &.{},
    problems: []const struct { Problem.Kind, u32, u32 } = &.{},
};

fn expectExtract(path: []const u8, source: []const u8, expected: Expected) !void {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var output: Output = .{ .gpa = arena.allocator() };
    try extract(arena.allocator(), &output, 0, path, source);

    try std.testing.expectEqual(expected.messages.len, output.ends.items.len);
    for (expected.messages, 0..) |message, index| {
        try std.testing.expectEqualStrings(message, output.message(index));
    }
    try std.testing.expectEqual(expected.problems.len, output.problems.items.len);
    for (expected.problems, output.problems.items) |want, got| {
        try std.testing.expectEqual(want[0], got.kind);
        try std.testing.expectEqual(want[1], got.line);
        try std.testing.expectEqual(want[2], got.column);
    }
    const partial = for (expected.problems) |want| {
        if (want[0] == .syntax) break true;
    } else false;
    if (partial) try std.testing.expectEqual(0, output.parsed.items.len);
}

test "messages of a module" {
    try expectExtract("app.tsx",
        \\import { t } from "dicto";
        \\export const App = ({ name }: { name: string }) => (
        \\  <main title={t('Home')}>
        \\    {t("Hello, {name}!", { name })}
        \\    {t(`Open // ticket status`)}
        \\    {t("Café \"quoted\"")}
        \\  </main>
        \\);
    , .{ .messages = &.{ "Home", "Hello, {name}!", "Open // ticket status", "Café \"quoted\"" } });
}

test "JSX in a JavaScript file" {
    try expectExtract("app.js",
        \\import { t } from "dicto";
        \\export const App = () => <p title={t("Title")}>{t("Body")}</p>;
    , .{ .messages = &.{ "Title", "Body" } });
}

test "only the imported binding counts" {
    try expectExtract("a.ts",
        \\import { t as translate } from 'dicto';
        \\translate("Renamed");
        \\function inner(t: (text: string) => string) { return t("Shadowed"); }
        \\{ const t = String; t("Local"); }
    , .{ .messages = &.{"Renamed"} });
    try expectExtract("b.ts",
        \\import { t } from "other";
        \\const name = "dicto";
        \\t("Another package");
    , .{});
    try expectExtract("c.ts",
        \\import type { t } from "dicto";
        \\import { locale } from "dicto";
        \\export type T = typeof t;
        \\locale();
    , .{});
    try expectExtract("d.ts",
        \\const t = (text) => text;
        \\t("No import");
    , .{});
}

test "calls that are not a literal" {
    try expectExtract("a.ts",
        \\import { t } from "dicto";
        \\const key = "Dynamic";
        \\t(key);
        \\t(`Hello ${key}`);
        \\t("a" + "b");
        \\t();
        \\t("");
        \\export const labels = ["One"].map(t);
        \\export { t };
    , .{ .problems = &.{
        .{ .call, 3, 3 },
        .{ .call, 4, 3 },
        .{ .call, 5, 3 },
        .{ .call, 6, 1 },
        .{ .call, 7, 3 },
        .{ .call, 8, 35 },
        .{ .call, 9, 10 },
    } });
}

test "imports that hide the calls" {
    try expectExtract("a.ts",
        \\import * as dicto from "dicto";
        \\export * from "dicto";
        \\export { t } from "dicto";
        \\export { locale } from "dicto";
        \\const lazy = await import("dicto");
    , .{ .problems = &.{
        .{ .import, 1, 8 },
        .{ .import, 5, 20 },
        .{ .import, 2, 1 },
        .{ .import, 3, 10 },
    } });
}

test "a file that does not parse" {
    try expectExtract("a.ts",
        \\import { t } from "dicto";
        \\t("Kept";
    , .{ .problems = &.{.{ .syntax, 2, 9 }} });
}
