/**
 * On staff forms (homework, remarks, notices): what families who read the
 * portal in Hindi will see of what is written here.
 */
import { translationOn } from "@/lib/translate";

export function HindiForFamilies({ what }: { what: string }) {
  return (
    <p className="text-[0.85rem] text-muted">
      {translationOn()
        ? `Families who read the portal in Hindi see ${what} translated into Hindi automatically. Short, plain sentences translate best.`
        : `Families who read the portal in Hindi see ${what} as you write it (automatic translation into Hindi isn’t set up). You can also write it in Hindi.`}
    </p>
  );
}
