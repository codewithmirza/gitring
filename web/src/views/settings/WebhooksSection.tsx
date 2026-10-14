/**
 * The Webhooks section of the settings: where gitring sends signed events.
 * At most five, https only. The words come from ../webhook-copy.ts.
 */
import { useEffect, useId, useState } from "react";
import { Button, Checkbox, CodeBlock, Field, Input, Select } from "../../design/components";
import type { SettingsAnswer, WebhookInput } from "../../../../src/core/types";
import { APPROVAL_EVENT_NOTE, WEBHOOK_EVENTS } from "../approval-copy";
import { SECRET_ONCE, SIGNATURE_HELP, secretLine } from "../webhook-copy";
import { SaveError, type SectionProps, useSave } from "./shared";

const MAX_WEBHOOKS = 5;
/** The server keeps only https URLs with a host name (others are dropped without a word). */
const URL_OK = /^https:\/\/[^\s/]+\.[^\s]+$/;

function newWebhook(): WebhookInput {
  const id = `wh_${Math.random().toString(36).slice(2, 10)}`;
  return { id, url: "", events: ["landing"], format: "json", enabled: true };
}

export function WebhooksSection({ projectId, owner, settings, onSaved }: SectionProps) {
  const approvalHelpId = `${useId().replace(/:/g, "")}-approval-help`;
  const [list, setList] = useState<WebhookInput[]>(settings.webhooks ?? []);
  const [tried, setTried] = useState(false);
  // The secrets of new webhooks: the server shows each one only once, in the answer of the save.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const { busy, error, setError, save } = useSave(projectId, (s) => {
    const { webhookSecrets, ...rest } = s as SettingsAnswer;
    setSecrets(webhookSecrets ?? {});
    onSaved(rest);
  });
  const saved = JSON.stringify(settings.webhooks ?? []);

  useEffect(() => {
    setList(settings.webhooks ?? []);
    setTried(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const change = (id: string, patch: Partial<WebhookInput>) => setList((l) => l.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const bad = (w: WebhookInput) => !URL_OK.test(w.url.trim());
  const dirty = JSON.stringify(list) !== saved;
  const before = new Map((settings.webhooks ?? []).map((w) => [w.id, w]));

  const submit = () => {
    setTried(true);
    if (list.some(bad)) {
      setError("Each webhook needs an https:// URL.");
      return;
    }
    void save({ webhooks: list.map((w) => ({ ...w, url: w.url.trim() })) }, "Webhooks saved");
  };

  return (
    <section className="st-sec" aria-labelledby="st-webhooks">
      <h2 className="page__h2" id="st-webhooks">
        Webhooks
      </h2>
      <p className="np__help">gitring sends a POST request to each webhook when an event happens: JSON, or a Slack message. At most {MAX_WEBHOOKS} webhooks.</p>
      <details className="st-fold">
        <summary>How your receiver checks a request</summary>
        <p className="np__help">{SIGNATURE_HELP}</p>
      </details>
      <p className="np__help" id={approvalHelpId}>
        {APPROVAL_EVENT_NOTE}
      </p>
      {list.length === 0 && <p className="np__help">No webhooks yet.</p>}
      <ul className="st-hooks">
        {list.map((w, i) => (
          <li key={w.id} className="st-hook">
            <div className="st-row">
              <Field label={`Webhook ${i + 1}: URL`} error={tried && bad(w) ? "Use an https:// URL, for example https://hooks.slack.com/services/…" : undefined}>
                <Input
                  className="voice-agent"
                  value={w.url}
                  onChange={(e) => change(w.id, { url: e.target.value })}
                  placeholder="https://example.com/gitring"
                  inputMode="url"
                  disabled={!owner}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Format">
                <Select value={w.format} disabled={!owner} onChange={(e) => change(w.id, { format: e.target.value === "slack" ? "slack" : "json" })}>
                  <option value="json">JSON</option>
                  <option value="slack">Slack message</option>
                </Select>
              </Field>
            </div>
            <fieldset className="st-hook__events" disabled={!owner}>
              <legend className="b-field__label">Events</legend>
              {WEBHOOK_EVENTS.map((ev) => (
                <Checkbox
                  key={ev.value}
                  label={ev.label}
                  checked={w.events.includes(ev.value)}
                  aria-describedby={ev.value === "approval" ? approvalHelpId : undefined}
                  onChange={(e) => change(w.id, { events: e.target.checked ? [...w.events, ev.value] : w.events.filter((x) => x !== ev.value) })}
                />
              ))}
            </fieldset>
            {secrets[w.id] ? (
              <>
                <CodeBlock label={`Webhook ${i + 1}: secret`} code={secrets[w.id]} copyLabel="Copy secret" />
                <p className="np__help" role="status">
                  {SECRET_ONCE}
                </p>
              </>
            ) : (
              <p className="np__help">{secretLine(w, before.get(w.id))}</p>
            )}
            <div className="st-actions">
              <Checkbox label="On" checked={w.enabled} disabled={!owner} onChange={(e) => change(w.id, { enabled: e.target.checked })} />
              {owner && before.has(w.id) && !w.newSecret && (
                <Button size="sm" variant="ghost" icon="key" onClick={() => change(w.id, { newSecret: true })}>
                  Make a new secret
                </Button>
              )}
              {owner && (
                <Button size="sm" variant="ghost" icon="close" onClick={() => setList((l) => l.filter((x) => x.id !== w.id))}>
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {owner && (
        <div className="st-actions">
          <Button icon="plus" disabled={list.length >= MAX_WEBHOOKS} onClick={() => setList((l) => [...l, newWebhook()])} title={list.length >= MAX_WEBHOOKS ? `At most ${MAX_WEBHOOKS} webhooks.` : undefined}>
            Add a webhook
          </Button>
          <Button variant="primary" busy={busy} disabled={!dirty} onClick={submit}>
            Save webhooks
          </Button>
        </div>
      )}
      {owner && dirty && <p className="np__help">The changes save when you click Save webhooks. A removed webhook stops after the save.</p>}
      <SaveError error={error} />
    </section>
  );
}
