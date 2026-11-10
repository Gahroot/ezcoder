// "ported" capture: every desktop UI piece hand-ported from upstream v0.109,
// rendered with the real components and our theme, for visual review.
import { useMemo } from "react";
import { TranscriptRow } from "../src/TranscriptRow";
import { ShellCommandMenu } from "../src/ShellCommandMenu";
import { ImageCard } from "../src/ImageCard";
import { ImageGenCard } from "../src/image-gen/ImageGenCard";
import { UpdateBanner } from "../src/UpdateBanner";
import { WorkspaceHeader } from "../src/WorkspaceHeader";
import { ChatPicker } from "../src/ChatPicker";
import { createLiveTextStore, LiveTextContext } from "../src/live-text";
import type { Item } from "../src/transcript-item";

const noop = (): void => {};
const VIEW = { visible: true } as const;
const consume = (): boolean => false;

// A small solid test image (64×64 indigo square) as a data URL.
const IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#3a4fb8"/><circle cx="160" cy="100" r="60" fill="#8fa3ff"/></svg>',
  );

const SHELL_DONE: Item = {
  kind: "shell",
  id: 1,
  runId: "r1",
  command: "pnpm test --filter @prestyj/ai",
  cwd: "~/ez-projects/ezcoder",
  status: "done",
  output: " Test Files  32 passed (32)\n      Tests  744 passed (744)\n   Duration  6.21s",
  exitCode: 0,
  durationMs: 6210,
};
const SHELL_FAIL: Item = {
  kind: "shell",
  id: 2,
  runId: "r2",
  command: "git push origin main",
  cwd: "~/ez-projects/ezcoder",
  status: "done",
  output: "error: failed to push some refs to 'origin'\nhint: Updates were rejected",
  exitCode: 1,
  durationMs: 840,
  shared: true,
};
const SHELL_CONFIRM: Item = {
  kind: "shell",
  id: 3,
  runId: "r3",
  command: "rm -rf dist && pnpm build",
  cwd: "~/ez-projects/ezcoder",
  status: "confirm",
  output: "",
};
const USER_WITH_FILES: Item = {
  kind: "user",
  id: 4,
  text: "Summarise the spec and the demo clip for me",
  images: [IMG],
  attachments: [
    { kind: "file", name: "product-spec.pdf" },
    { kind: "video", name: "demo-walkthrough.mov" },
  ],
  files: ["src/App.tsx"],
};
const IMAGES: Item = {
  kind: "images",
  id: 5,
  images: [{ src: IMG, path: "/Users/nolan/ez-projects/ezcoder/.ezcoder/images/logo-idea.png" }],
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          font: "600 12px var(--sans)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          margin: "0 0 10px",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function PortedShowcase(): React.ReactElement {
  const liveText = useMemo(() => createLiveTextStore(), []);
  const actions = { confirm: noop, stop: noop };
  const row = (item: Item) => (
    <TranscriptRow
      key={item.id}
      item={item}
      view={VIEW}
      consumeEntrance={consume}
      shellActions={actions}
    />
  );
  return (
    <div className="app" style={{ overflow: "auto", height: "100vh" }}>
      <WorkspaceHeader
        workspaceMode="chat"
        cwd="/Users/nolan/ez-projects/EZ Chat"
        title={"Plan my trip to Kyoto in spr\u2026"}
        navHidden={false}
        onToggleNav={noop}
      >
        <span />
      </WorkspaceHeader>
      <LiveTextContext.Provider value={liveText}>
        <div className="transcript" style={{ padding: "16px var(--rail, 20px)" }}>
          <Section title="! terminal commands">
            {row(SHELL_DONE)}
            {row(SHELL_FAIL)}
            {row(SHELL_CONFIRM)}
            <div
              className="inputwrap shell-mode"
              style={{ position: "relative", marginTop: 170, minHeight: 44 }}
            >
              <ShellCommandMenu
                suggestions={[
                  { command: "pnpm test", count: 12 },
                  { command: "pnpm build", count: 4 },
                  { command: "pnpm lint", count: 0, source: "package.json" },
                ]}
                activeIndex={0}
                trusted
                onRevokeTrust={noop}
                onSelect={noop}
                onHover={noop}
              />
            </div>
          </Section>
          <Section title="File chips on attachments">{row(USER_WITH_FILES)}</Section>
          <Section title="Image save button">
            {row(IMAGES)}
            <ImageCard src={IMG} alt="no file" />
          </Section>
          <Section title="Image generation progress (GIF)">
            <div className="img-grid">
              <ImageGenCard
                prompt="a pixel-art fox waving, looping"
                gif
                startedAt={Date.now() - 14_000}
              />
            </div>
          </Section>
          <Section title="Update failed">
            <UpdateBanner
              appUpdate={{
                phase: "error",
                version: "0.93.0",
                progress: null,
                error: "signature mismatch",
                install: async () => {},
              }}
            />
          </Section>
          <Section title="EZ Chat folder (chat picker)">
            <div style={{ height: 420, position: "relative", overflow: "hidden" }}>
              <ChatPicker onChosen={noop} onClose={noop} mode="chat" />
            </div>
          </Section>
        </div>
      </LiveTextContext.Provider>
    </div>
  );
}
