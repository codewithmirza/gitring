/**
 * Drydock — runs a project's own install and test commands in a Linux container (Cloudflare
 * Containers, `durable_object` scheduling policy, the managed Node.js 24 image).
 *
 * One Drydock per attempt. The container stays up for a few minutes after a run, so the next run of
 * the same attempt reuses node_modules when the lockfile did not change.
 *
 * Network: the container has no direct Internet access. HTTP and HTTPS go through Seawall, a Worker
 * entrypoint that lets requests to package registries pass and refuses every other host.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../worker/env";
import { gzip, modeFor, tar } from "../platform/checks/tar";

export const DRYDOCK_IMAGE = "cloudflare/debian-trixie";
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const IDLE_MS = 8 * 60_000;
/** 1 vCPU, 4 GiB memory, 8 GB disk: enough for npm installs of most projects. */
const CHECK_INSTANCE: ContainerStartResources = { vcpu: 1, memoryMib: 4096, diskMb: 8000 };
const LOG_TAIL = 8_000;

/** Hosts that check containers may reach: package registries and source archives. */
export const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmmirror.com",
  "nodejs.org",
  "deb.debian.org",
  "security.debian.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

export function registryAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return REGISTRY_HOSTS.includes(h);
}

export interface DrydockRun {
  /** gzip-compressed tar of the tree under test. */
  tree: Uint8Array;
  install?: string;
  test?: string;
  timeoutSec: number;
}

export interface DrydockResult {
  ok: boolean;
  /** "install", "test", "no-test", "timeout" or "start". */
  stage: "install" | "test" | "no-test" | "timeout" | "start" | "done";
  exitCode: number;
  installMs: number;
  testMs: number;
  /** Did the run reuse node_modules from the previous run? */
  reused: boolean;
  log: string;
}

/** Shell script of one run. Bearing's markers on stdout tell the stages apart. */
export function runScript(): string {
  return String.raw`set -u
W=/workspace
cd "$W" || exit 90
FP=$(cat package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock package.json 2>/dev/null | sha256sum | cut -c1-16)
REUSED=0
if [ -d "/cache/nm-$FP" ] && [ ! -e node_modules ]; then mv "/cache/nm-$FP" node_modules && REUSED=1; fi
echo "@@bearing reused=$REUSED"
echo "@@bearing stage=install"
T0=$(date +%s%3N)
if [ "$REUSED" = "1" ]; then :
elif [ -n "$BEARING_INSTALL" ]; then bash -lc "$BEARING_INSTALL" || { echo "@@bearing install-failed=$?"; exit 91; }
elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --no-audit --no-fund --loglevel=error || { echo "@@bearing install-failed=$?"; exit 91; }
elif [ -f package.json ]; then npm install --no-audit --no-fund --loglevel=error || { echo "@@bearing install-failed=$?"; exit 91; }
fi
T1=$(date +%s%3N)
echo "@@bearing install-ms=$((T1-T0))"
echo "@@bearing stage=test"
if [ -n "$BEARING_TEST" ]; then bash -lc "$BEARING_TEST"; CODE=$?
elif [ -f package.json ] && node -e 'process.exit(require("./package.json").scripts?.test ? 0 : 1)'; then npm test; CODE=$?
else echo "@@bearing no-test"; exit 92; fi
T2=$(date +%s%3N)
echo "@@bearing test-ms=$((T2-T1))"
mkdir -p /cache && rm -rf /cache/nm-* 2>/dev/null
if [ -d node_modules ]; then mv node_modules "/cache/nm-$FP"; fi
exit $CODE
`;
}

/** Parse a run's combined output into a result. */
export function parseRun(output: string, exitCode: number): DrydockResult {
  const marker = (k: string) => new RegExp(`^@@bearing ${k}=(\\d+)$`, "m").exec(output)?.[1];
  const reused = marker("reused") === "1";
  const installMs = Number(marker("install-ms") ?? 0);
  const testMs = Number(marker("test-ms") ?? 0);
  const cleaned = output.replace(/^@@bearing .*\n?/gm, "");
  const log = cleaned.length > LOG_TAIL ? `…${cleaned.slice(-LOG_TAIL)}` : cleaned;
  let stage: DrydockResult["stage"] = "done";
  if (exitCode === 124 || exitCode === 137) stage = "timeout";
  else if (exitCode === 91) stage = "install";
  else if (exitCode === 92) stage = "no-test";
  else if (exitCode !== 0) stage = "test";
  return { ok: exitCode === 0, stage, exitCode, installMs, testMs, reused, log };
}

export class Drydock extends DurableObject<Env> {
  private ready?: Promise<void>;

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("This Worker has no container for checks. Add the Drydock container to wrangler.jsonc.");
    return c;
  }

  /** Start the container once, with outbound HTTP(S) through Seawall. */
  private ensureRunning(instance: ContainerStartupOptions["instance"] = CHECK_INSTANCE, internet = false): Promise<void> {
    if (this.ready && this.container.running) return this.ready;
    this.ready = (async () => {
      const c = this.container;
      // The image's own command (node) exits at once without a terminal; a container lives as long as its main process.
      if (!c.running) c.start({ image: DRYDOCK_IMAGE, entrypoint: ["sleep", "infinity"], enableInternet: internet, instance, labels: { app: "bearing-checks" } });
      const gate = (this.ctx.exports as unknown as { Seawall: (o: { props: Record<string, never> }) => Fetcher }).Seawall({ props: {} });
      await c.interceptOutboundHttps("*", gate);
      await c.interceptOutboundHttp("*", gate);
      await c.setInactivityTimeout(IDLE_MS);
    })().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  /** Copy the tree into /workspace, then run install and test with a time limit. */
  async run(input: DrydockRun): Promise<DrydockResult> {
    const started = Date.now();
    try {
      await this.ensureRunning();
    } catch (e) {
      return { ok: false, stage: "start", exitCode: -1, installMs: 0, testMs: 0, reused: false, log: `The check container did not start: ${String((e as Error).message ?? e)}` };
    }
    const c = this.container;
    const env = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      CI: "true",
      NODE_EXTRA_CA_CERTS: CA,
      SSL_CERT_FILE: CA,
      REQUESTS_CA_BUNDLE: CA,
      PIP_CERT: CA,
      GIT_SSL_CAINFO: CA,
      npm_config_update_notifier: "false",
      BEARING_INSTALL: input.install ?? "",
      BEARING_TEST: input.test ?? "",
    };
    // A fresh tree each run; node_modules waits in /cache between runs.
    const prep = await c.exec(["bash", "-c", "if [ -d /workspace/node_modules ]; then mkdir -p /cache && mv /workspace/node_modules /cache/nm-orphan; fi; rm -rf /workspace && mkdir -p /workspace"], { env });
    await prep.output();
    const stdin = new Blob([input.tree as unknown as ArrayBuffer]).stream();
    const untar = await c.exec(["tar", "-xzf", "-", "-C", "/workspace", "--no-same-owner"], { env, stdin });
    const unpacked = await untar.output();
    if (unpacked.exitCode !== 0) {
      return { ok: false, stage: "start", exitCode: unpacked.exitCode, installMs: 0, testMs: 0, reused: false, log: `Bearing could not copy the tree into the container: ${new TextDecoder().decode(unpacked.stderr).slice(0, 2000)}` };
    }
    const seconds = Math.max(60, Math.min(1800, Math.round(input.timeoutSec)));
    const proc = await c.exec(["timeout", "--kill-after=10", String(seconds), "bash", "-c", runScript()], { env, cwd: "/workspace", stderr: "combined" });
    const out = await proc.output();
    const text = new TextDecoder().decode(out.stdout);
    const res = parseRun(text, out.exitCode);
    if (res.stage === "timeout") res.log = `${res.log}\nThe run took more than ${seconds} s. Bearing stopped it.`;
    if (!res.installMs && !res.testMs) res.testMs = Date.now() - started;
    return res;
  }

  /** Operator diagnostics: run a few read-only commands and report exit codes and output. */
  async diag(opts: { instance?: string; internet?: boolean } = {}): Promise<{ running: boolean; results: { cmd: string; exitCode: number; out: string }[] }> {
    const results: { cmd: string; exitCode: number; out: string }[] = [];
    try {
      const size = opts.instance?.startsWith("{") ? (JSON.parse(opts.instance) as ContainerStartResources) : ((opts.instance as ContainerStartupOptions["instance"]) ?? CHECK_INSTANCE);
      await this.ensureRunning(size, Boolean(opts.internet));
    } catch (e) {
      return { running: false, results: [{ cmd: "start", exitCode: -1, out: String((e as Error).message ?? e) }] };
    }
    const cmds = [
      ["sh", "-c", "id; uname -a; cat /etc/os-release | head -3"],
      ["sh", "-c", "command -v bash tar gzip timeout node npm sha256sum date; node --version; npm --version"],
      ["sh", "-c", "ls -la / /workspace 2>&1 | head -40; df -h / | tail -1; free -m 2>/dev/null | head -2"],
      ["sh", "-c", "ls -la /etc/cloudflare/certs/ 2>&1"],
      ["timeout", "20", "sh", "-c", "NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt node -e \"fetch('https://registry.npmjs.org/left-pad').then(r=>console.log('npm registry',r.status)).catch(e=>console.log('fetch failed',e.cause?.code||e.message))\""],
      ["timeout", "20", "sh", "-c", "NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt node -e \"fetch('https://example.com/').then(r=>console.log('example.com',r.status)).catch(e=>console.log('fetch failed',e.cause?.code||e.message))\""],
    ];
    for (const cmd of cmds) {
      try {
        const p = await this.container.exec(cmd, { stderr: "combined" });
        const o = await p.output();
        results.push({ cmd: cmd.join(" ").slice(0, 120), exitCode: o.exitCode, out: new TextDecoder().decode(o.stdout).slice(0, 3000) });
      } catch (e) {
        results.push({ cmd: cmd.join(" ").slice(0, 120), exitCode: -1, out: `exec threw: ${String((e as Error).message ?? e)}` });
      }
    }
    return { running: this.container.running, results };
  }

  /** Stop the container now (the attempt is closed). */
  async stop(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    this.ready = undefined;
  }
}

/** Outbound gate for check containers: package registries pass, every other host gets 403. */
export class Seawall extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!registryAllowed(url.hostname)) {
      return new Response(`Bearing check containers reach package registries only. ${url.hostname} is not one of them.\n`, { status: 403 });
    }
    return fetch(request);
  }
}

/** The tree under test as gzip tar bytes. */
export async function packTree(files: Map<string, string>): Promise<Uint8Array> {
  const entries = [...files].map(([path, content]) => ({ path, content, mode: modeFor(path) }));
  return gzip(tar(entries));
}
