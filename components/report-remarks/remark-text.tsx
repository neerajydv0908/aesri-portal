/** A saved report-card remark, line by line, each line marked English or Hindi by its script. */
import { langOfText } from "@/lib/i18n";

export function RemarkText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {text.split("\n").map((line, i) =>
        line.trim() ? (
          <p key={i} lang={langOfText(line)}>
            {line}
          </p>
        ) : null,
      )}
    </div>
  );
}
