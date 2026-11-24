import { describe, expect, it } from "vitest";
import { chooseNode, type NodeView, type PlacementRequest } from "./fleet-scheduler.js";
import { nodeInfo } from "./__fixtures__/fake-node.js";
import type { NodeInfo } from "./protocol.js";

const view = (name: string, over: Partial<NodeInfo> = {}, online = true): NodeView => ({
  name,
  online,
  info: nodeInfo(name, over),
});
const job = (over: Partial<PlacementRequest> = {}): PlacementRequest => ({
  takesSlot: true,
  ...over,
});
const picked = (p: ReturnType<typeof chooseNode>) => ("node" in p ? p.node.name : p);

describe("chooseNode", () => {
  const gpu = view("gpu-box", {
    gpus: [{ name: "RTX", memoryGb: 24, memoryUsedGb: 2, vendor: "nvidia" }],
  });
  const plain = view("my-pc");

  it("puts GPU work on GPU nodes and checks GPU memory", () => {
    expect(picked(chooseNode(job({ resources: { gpus: 1 } }), [plain, gpu]))).toBe("gpu-box");
    const p = chooseNode(job({ resources: { gpus: 1, gpuMemoryGb: 48 } }), [plain, gpu]);
    expect(p).toMatchObject({ error: expect.stringMatching(/no node fits/) });
  });

  it("requires labels (gpu is implicit) and deploy for secrets", () => {
    const deploy = view("ci-box", { labels: ["deploy"] });
    expect(picked(chooseNode(job({ resources: { labels: ["deploy"] } }), [plain, deploy]))).toBe(
      "ci-box",
    );
    expect(picked(chooseNode(job({ resources: { labels: ["gpu"] } }), [plain, gpu]))).toBe(
      "gpu-box",
    );
    expect(picked(chooseNode(job({ secrets: ["TOKEN"] }), [plain, deploy]))).toBe("ci-box");
    expect(chooseNode(job({ secrets: ["TOKEN"] }), [plain])).toHaveProperty("error");
  });

  it("errors when nothing could ever fit, waits when it's only busy", () => {
    expect(chooseNode(job({ resources: { memoryGb: 64 } }), [plain])).toHaveProperty("error");
    // Fits the machine but not the free memory right now.
    const tight = view("my-pc", { memoryFreeGb: 4 });
    expect(chooseNode(job({ resources: { memoryGb: 16 } }), [tight])).toHaveProperty("wait");
    expect(chooseNode(job(), [view("my-pc", {}, false)])).toHaveProperty("wait");
  });

  it("counts our in-flight jobs against slots", () => {
    const a = view("a", { slots: 1 });
    const b = view("b", { slots: 2 });
    expect(picked(chooseNode(job(), [a, b], [{ node: "a" }]))).toBe("b");
    expect(chooseNode(job(), [a, b], [{ node: "a" }, { node: "b" }, { node: "b" }])).toHaveProperty(
      "wait",
    );
    // Services don't take slots.
    expect(picked(chooseNode(job({ takesSlot: false }), [a], [{ node: "a" }]))).toBe("a");
  });

  it("prefers affinity, then the emptiest, then the least loaded; avoids lost nodes", () => {
    const a = view("a", { load: 0.9 });
    const b = view("b", { load: 0.1 });
    expect(picked(chooseNode(job(), [a, b]))).toBe("b");
    expect(picked(chooseNode(job({ affinity: "a" }), [a, b]))).toBe("a");
    expect(picked(chooseNode(job({ affinity: "a", avoid: ["a"] }), [a, b]))).toBe("b");
    expect(
      picked(
        chooseNode(job(), [
          view("a", { slots: 2, slotsUsed: 1 }),
          view("b", { slots: 2, load: 2 }),
        ]),
      ),
    ).toBe("b");
  });

  it("honours a pinned node", () => {
    expect(picked(chooseNode(job({ node: "my-pc" }), [plain, gpu]))).toBe("my-pc");
    expect(chooseNode(job({ node: "nope" }), [plain])).toHaveProperty("error");
  });
});
