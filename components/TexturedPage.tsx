// The full-viewport textured field first built for the login page, now the
// one shared implementation for every screen except "My timesheet". Two
// variants of the same wrapper, not two patterns:
//   center — a single opaque card floating in the field (login).
//   panel  — the page's content column sits on an OPAQUE panel in the
//            page-background color, so every text/card pixel has exactly the
//            same backdrop it had before the texture existed. The texture is
//            only ever visible in the margins and empty space around the
//            content, never underneath it — that's what lets it be genuinely
//            obvious without touching legibility.
//
// data-textured-page is a pure CSS hook (see globals.css's
// `body:has([data-textured-page])` rule) that stretches <body>/<main> to fill
// the viewport ONLY while a textured screen is mounted, without touching
// layout.tsx — header height varies (it wraps at narrow widths), so a
// hardcoded calc() would be wrong at some size.
//
// Oversized past plain `cover` on purpose: the source JPG has a white
// "Kalthum Foundation For Peace" caption strip across its bottom ~12%; at a
// narrow/tall viewport `cover` matches container height exactly with zero
// crop margin, so that strip renders as a stray white band. Sizing to at
// least 135% of both viewport dimensions and anchoring toward the top pushes
// the crop margin to the bottom and keeps the strip out of frame.
export function TexturedPage({
  children,
  variant = "panel",
}: {
  children: React.ReactNode;
  variant?: "panel" | "center";
}) {
  return (
    <div data-textured-page className="relative isolate flex w-full flex-1 overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          opacity: "var(--page-bg-opacity)",
          backgroundImage: "url(/kfp-logo.jpg)",
          backgroundSize: "max(135vw, 135vh)",
          backgroundPosition: "center 15%",
          backgroundRepeat: "no-repeat",
        }}
      />
      {variant === "center" ? (
        <div className="flex w-full items-center justify-center px-4 py-8 sm:px-0">{children}</div>
      ) : (
        <div className="mx-auto w-full max-w-3xl self-start px-3 py-4 sm:px-5 sm:py-8">
          <div data-textured-panel className="rounded-2xl border border-border bg-page p-4 sm:p-6">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
