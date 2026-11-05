import { Link } from "@cloudflare/kumo";
import { REPO_URL, SPEC_VERSIONS, type SpecVersion, schemaPath, specVersion } from "../lib/site";

export function SiteHeader({ current, version }: { current: string; version: string }) {
  const spec = specVersion(version);
  const nav = [
    { href: spec.href, label: "Specification" },
    { href: "/mappings/", label: "Mappings" },
    { href: "/examples/", label: "Examples" },
    { href: schemaPath(version), label: "Schema" },
  ];
  return (
    <header className="sticky top-0 z-10 border-b border-kumo-hairline bg-kumo-base/90 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-5 sm:gap-6">
        <a href="/" className="font-semibold tracking-tight text-kumo-strong no-underline">
          ATXF
        </a>
        <VersionSwitch version={version} />
        <nav aria-label="Primary" className="ml-auto flex items-center gap-5 overflow-x-auto text-sm">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              variant="plain"
              aria-current={current === item.href ? "page" : undefined}
              className={
                current === item.href
                  ? "whitespace-nowrap font-medium text-kumo-strong"
                  : "whitespace-nowrap text-kumo-subtle hover:text-kumo-strong"
              }
            >
              {item.label}
            </Link>
          ))}
          <Link href={REPO_URL} variant="plain" className="whitespace-nowrap text-kumo-subtle hover:text-kumo-strong">
            GitHub
          </Link>
        </nav>
      </div>
    </header>
  );
}

/** A dropdown of the spec's versions, showing the version the page belongs to. */
function VersionSwitch({ version }: { version: string }) {
  const label = (v: SpecVersion) => (v.stage === "draft" ? "draft" : "current");
  const selected = specVersion(version);
  return (
    <details data-version-menu="" className="relative shrink-0 text-xs">
      <summary
        aria-label={`Specification version: ${selected.version}`}
        className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-kumo-hairline px-2 py-1 text-kumo-strong hover:bg-kumo-recessed [&::-webkit-details-marker]:hidden"
      >
        <span className="font-medium">v{selected.version}</span>
        {selected.stage === "draft" && <span className="text-kumo-subtle">draft</span>}
        <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 text-kumo-subtle">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <ul className="absolute left-0 top-full z-20 mt-1 min-w-44 rounded-md border border-kumo-hairline bg-kumo-elevated p-1 shadow-lg">
        {[...SPEC_VERSIONS].reverse().map((v) => (
          <li key={v.version}>
            <a
              href={v.href}
              data-version-link=""
              aria-current={v.version === version ? "page" : undefined}
              className={
                "flex items-center justify-between gap-4 rounded px-2 py-1.5 no-underline hover:bg-kumo-recessed " +
                (v.version === version ? "font-medium text-kumo-strong" : "text-kumo-default")
              }
            >
              <span>v{v.version}</span>
              <span className="text-kumo-subtle">{label(v)}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
