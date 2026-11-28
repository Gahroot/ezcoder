// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DoctorLines } from "./DoctorLines";
import type { DoctorReport } from "./agent";

afterEach(cleanup);

const REPORT: DoctorReport = {
  node: "gpu-box",
  version: "1.2.0",
  protocol: 2,
  ok: false,
  checks: [
    { id: "docker", status: "ok", detail: "Docker is running." },
    {
      id: "model_login",
      status: "warn",
      detail: "It has no model login.",
      fix: "ezcoder login",
    },
    {
      id: "slots",
      status: "fail",
      detail: "No room for work.",
      fix: "ezcoder node config --slots 2",
    },
    { id: "gpu", status: "skip", detail: "No graphics card found.", fix: "never shown" },
  ],
};

describe("DoctorLines", () => {
  it("shows one line per check in plain words, with fixes only for problems", () => {
    render(<DoctorLines report={REPORT} />);
    expect(screen.getByRole("status").textContent).toBe(
      "gpu-box needs a fix before it can take all work.",
    );
    const lines = screen.getAllByRole("listitem");
    expect(lines.map((l) => l.getAttribute("data-status"))).toEqual(["ok", "warn", "fail", "skip"]);
    expect(lines[0]?.textContent).toContain("Docker");
    expect(lines[0]?.textContent).not.toContain("To fix");
    expect(lines[1]?.textContent).toContain("Model login: Worth a look.");
    expect(lines[1]?.textContent).toContain("To fix: ezcoder login");
    expect(lines[2]?.textContent).toContain("Needs fixing");
    expect(lines[2]?.textContent).toContain("ezcoder node config --slots 2");
    expect(lines[3]?.textContent).not.toContain("never shown");
  });

  it("says the machine is ready when nothing failed", () => {
    render(<DoctorLines report={{ ...REPORT, ok: true, checks: [REPORT.checks[0]!] }} />);
    expect(screen.getByRole("status").textContent).toBe("gpu-box is ready to take work.");
  });
});
