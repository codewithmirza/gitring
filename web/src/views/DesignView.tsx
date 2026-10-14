/**
 * The style guide page (/design): it renders the real tokens and components, so it cannot drift from the product.
 * This file puts the page together. The parts are in design/ (read design/README.md).
 */
import { Button, Dialog, Field, Textarea } from "../design/components";
import { Icon, Mark } from "../design/icons";
import { TOC } from "./design/layout";
import { ChartAndRules } from "./design/ChartAndRules";
import { ComponentsSection } from "./design/ComponentsSection";
import { Foundations } from "./design/Foundations";
import { useDesignState } from "./design/useDesignState";
import "../chart/chart.css";
import "./design.css";

export function DesignView() {
  const samples = useDesignState();
  const { dialog, setDialog } = samples;
  return (
    <div className="ds">
      <nav className="ds-toc" aria-label="Style guide sections">
        <p className="ds-toc__title">
          <Mark size={18} /> Chart room
        </p>
        <ol>
          {TOC.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="ds-main">
        <header className="ds-hero">
          <p className="page__eyebrow">
            <Icon name="grid" size={14} /> gitring design system · v0.1
          </p>
          <h1 className="ds-title" tabIndex={-1}>
            Chart room
          </h1>
          <p className="ds-hero__lede">
            gitring is a chart room for coding agents. Many agents move through one codebase at the same time. A human reads the chart, makes decisions and
            keeps the fleet clear of collisions. This page renders the real tokens and components.
          </p>
          <div className="ds-hero__voices">
            <p className="voice-human">“Add a dark mode. Keep text contrast at 4.5:1 or more.”</p>
            <p className="voice-agent">KESTREL-7 · formatPrice(cents, currency) · 0.58</p>
            <p className="voice-system">Land attempt · Declare course · Amend intent</p>
          </div>
        </header>

        <Foundations samples={samples} />

        <ComponentsSection samples={samples} />

        <ChartAndRules />
      </div>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Land PETREL-2"
        description="gitring composes the attempt with main, runs every landed check, then lands it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="anchor" onClick={() => setDialog(false)}>
              Land attempt
            </Button>
          </>
        }
      >
        <Field label="Why this attempt?" help="Your reason goes into the logbook.">
          <Textarea voice="human" rows={3} defaultValue="Smaller diff. The search form stays out of the header." />
        </Field>
      </Dialog>
    </div>
  );
}
