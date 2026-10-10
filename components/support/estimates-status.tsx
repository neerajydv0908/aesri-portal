/** A note above "Needs support" when Stud-AI's estimates are missing or out of date (teachers only). */
import { Alert } from "@/components/ui";
import type { EstimatesStatus } from "@/lib/studai/estimates";

export function EstimatesNotice({ status, className }: { status: EstimatesStatus; className?: string }) {
  if (status.state === "off") {
    return (
      <Alert tone="blue" title="No Stud-AI estimates on this server" className={className}>
        Stud-AI isn&rsquo;t set up here yet, so there are no estimates: students are red only for low attendance together with concerns, &ldquo;Review needed&rdquo; for a
        subject&rsquo;s most recent exam mark below the pass mark or an absence from it, and grey otherwise. The school office can see how to set it up in Settings.
      </Alert>
    );
  }
  if (status.state === "problem") {
    return (
      <Alert tone="amber" title="Stud-AI isn't working on this server right now" className={className}>
        <p>
          Until it is fixed, students are red only for low attendance together with concerns, and &ldquo;Review needed&rdquo; for a most recent mark below the pass mark or an absence. Please tell
          the school office.
        </p>
        <p className="mt-1 text-[0.85rem]">What went wrong: {status.message}</p>
      </Alert>
    );
  }
  if (status.state === "stale") {
    return (
      <Alert tone="amber" title="Some estimates couldn't be updated just now" className={className}>
        <p>The estimates marked &ldquo;out of date&rdquo; were worked out before the latest marks, homework or attendance. They update once Stud-AI is working again.</p>
        <p className="mt-1 text-[0.85rem]">What went wrong: {status.message}</p>
      </Alert>
    );
  }
  if (status.refused.length) {
    return (
      <Alert tone="blue" title="Stud-AI couldn't estimate some subjects" className={className}>
        <ul className="list-disc pl-5">
          {[...new Set(status.refused)].slice(0, 5).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Alert>
    );
  }
  return null;
}
