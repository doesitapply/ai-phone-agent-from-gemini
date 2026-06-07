export type RoutedMember = {
  id: number;
  name: string;
  role: string;
  phone: string | null;
  email: string | null;
};

export type TeamRoutingCandidate = RoutedMember & {
  is_on_call: boolean;
  handles_topics: string[] | null;
  priority: number;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const includesWord = (text: string, word: string): boolean => new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text);

export function scoreTeamMemberForEscalation(member: TeamRoutingCandidate, searchText: string): number {
  const normalizedSearch = searchText.toLowerCase();
  let score = member.priority;

  if (member.is_on_call) score += 1000;

  const name = member.name.toLowerCase().trim();
  const email = member.email?.toLowerCase().trim() || "";
  if (name && normalizedSearch.includes(name)) score += 5000;
  if (email && normalizedSearch.includes(email)) score += 5000;

  const nameParts = name.split(/\s+/).filter((part) => part.length > 2);
  for (const part of nameParts) {
    if (includesWord(normalizedSearch, part)) score += 1500;
  }

  const role = member.role.toLowerCase().trim();
  if (role && normalizedSearch.includes(role)) score += 80;

  const topics = (member.handles_topics || []).map((topic) => topic.toLowerCase());
  for (const topic of topics) {
    if (normalizedSearch.includes(topic)) score += 50;

    const words = topic.split(/\s+/);
    for (const word of words) {
      if (word.length > 3 && normalizedSearch.includes(word)) score += 10;
    }
  }

  return score;
}
