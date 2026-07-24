import { describe, expect, it } from "vitest";
import { toWslPath } from "../src/runs/runner.ts";

describe("toWslPath", () => {
	it("converts a simple Windows path", () => {
		expect(toWslPath("C:\\foo\\bar")).toBe("/mnt/c/foo/bar");
	});

	it("lowercases the drive letter", () => {
		expect(toWslPath("D:\\Data\\file.py")).toBe("/mnt/d/Data/file.py");
	});

	it("preserves spaces in path segments", () => {
		expect(toWslPath("C:\\Users\\drew m\\Program Files\\x.py")).toBe("/mnt/c/Users/drew m/Program Files/x.py");
	});

	it("handles a bare drive root", () => {
		expect(toWslPath("C:\\")).toBe("/mnt/c/");
	});

	it("accepts an already-forward-slashed drive path", () => {
		expect(toWslPath("C:/foo/bar")).toBe("/mnt/c/foo/bar");
	});

	it("throws for a path without a drive letter", () => {
		expect(() => toWslPath("relative\\path")).toThrow();
	});

	it("throws for a UNC path", () => {
		expect(() => toWslPath("\\\\server\\share\\file.py")).toThrow();
	});
});
