import { useState, type ReactNode } from "react";
import { Button } from "./Button";

interface CodeBlockProps {
  code: string;
  /** File name or language shown in the header. */
  label?: string;
  copyLabel?: string;
  /** Shell blocks show "$ " prompts that are not copied. */
  shell?: boolean;
  children?: ReactNode;
}

function highlight(code: string, shell: boolean) {
  return code.split("\n").map((line, i) => {
    const out: ReactNode[] = [];
    if (shell && line.trim() && !line.trimStart().startsWith("#")) out.push(<span key="p" className="tok-p">$ </span>);
    const comment = shell ? line.match(/^(\s*#.*)$/) : line.match(/^(\s*\/\/.*)$/);
    if (comment) out.push(<span key="c" className="tok-c">{line}</span>);
    else out.push(<span key="t">{line}</span>);
    return (
      <span key={i}>
        {out}
        {"\n"}
      </span>
    );
  });
}

/** CodeBlock: mono block with a "Copy command" button. */
export function CodeBlock({ code, label, copyLabel = "Copy command", shell = false }: CodeBlockProps) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied("idle"), 1800);
  };
  return (
    <div className="b-code">
      <div className="b-code__head">
        {label && <span className="b-code__label">{label}</span>}
        <Button size="sm" variant="ghost" icon={copied === "ok" ? "check" : "copy"} onClick={copy} aria-live="polite">
          {copied === "ok" ? "Copied" : copied === "fail" ? "Select the text to copy" : copyLabel}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={label ? `${label} code` : "Code"}>
        <code>{highlight(code.replace(/\n$/, ""), shell)}</code>
      </pre>
    </div>
  );
}
