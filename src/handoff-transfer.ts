export type HumanTransferCandidate = {
  phone?: string | null;
  name?: string | null;
  source: "tool" | "handoff_record" | "env";
};

export type HumanTransferTarget = {
  phone: string;
  name: string | null;
  source: HumanTransferCandidate["source"];
};

export const normalizePhoneDigits10 = (value: string | null | undefined): string =>
  String(value || "").replace(/\D/g, "").slice(-10);

export const isSamePhoneNumber = (left: string | null | undefined, right: string | null | undefined): boolean => {
  const leftDigits = normalizePhoneDigits10(left);
  const rightDigits = normalizePhoneDigits10(right);
  return leftDigits.length === 10 && rightDigits.length === 10 && leftDigits === rightDigits;
};

export function chooseSafeHumanTransferTarget(
  candidates: HumanTransferCandidate[],
  blockedPhones: Array<string | null | undefined>
): HumanTransferTarget | null {
  for (const candidate of candidates) {
    const phone = String(candidate.phone || "").trim();
    if (normalizePhoneDigits10(phone).length !== 10) continue;
    if (blockedPhones.some((blocked) => isSamePhoneNumber(phone, blocked))) continue;
    return {
      phone,
      name: candidate.name || null,
      source: candidate.source,
    };
  }
  return null;
}
