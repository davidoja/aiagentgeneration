// Free-mail providers named for this sync. The first DNS label is matched so
// gmail.com, gmail.co.uk, gmx.de, and t-online.de are all excluded. web.de,
// me.com, and mac.com do not share that label shape, so they are exact.
// live.com, msn.com, aol.com, and proton.me are not in this list.
const FREE_MAIL_FIRST_LABELS = new Set([
  "gmail",
  "googlemail",
  "gmx",
  "outlook",
  "hotmail",
  "yahoo",
  "icloud",
  "t-online",
]);

const FREE_MAIL_EXACT = new Set([
  "web.de",
  "me.com",
  "mac.com",
]);

export type BarberLead = {
  id: string;
  domain?: string | null;
  emails?: unknown;
  company_domain_emails?: unknown;
};

export type MatchReason = "email" | "domain" | "none";

export type MatchResult = {
  leadId: string | null;
  reason: MatchReason;
};

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) {
    return null;
  }
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@") || at === value.length - 1) {
    return null;
  }
  return value;
}

export function emailDomain(email: string): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  return normalized.slice(normalized.lastIndexOf("@") + 1);
}

export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  let domain = value.trim().toLowerCase();
  if (!domain) {
    return null;
  }
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  domain = domain.replace(/^www\./, "");
  domain = domain.split("/")[0]?.split("?")[0]?.split("#")[0] ?? "";
  const colon = domain.indexOf(":");
  if (colon >= 0) {
    domain = domain.slice(0, colon);
  }
  if (!domain || domain.includes("@") || !domain.includes(".")) {
    return null;
  }
  return domain;
}

export function isFreeMailDomain(domain: string | null | undefined): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return false;
  }
  if (FREE_MAIL_EXACT.has(normalized)) {
    return true;
  }
  const first = normalized.split(".")[0];
  return FREE_MAIL_FIRST_LABELS.has(first);
}

export function coerceEmailList(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => coerceEmailList(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.email === "string") {
      return coerceEmailList(record.email);
    }
    return [];
  }
  if (typeof value === "string") {
    return value
      .split(/[,;\s]+/)
      .map((part) => normalizeEmail(part))
      .filter((part): part is string => part !== null);
  }
  return [];
}

function leadEmails(lead: BarberLead): string[] {
  return [
    ...coerceEmailList(lead.emails),
    ...coerceEmailList(lead.company_domain_emails),
  ];
}

function leadMatchesDomain(lead: BarberLead, domain: string): boolean {
  if (normalizeDomain(lead.domain) === domain) {
    return true;
  }
  return coerceEmailList(lead.company_domain_emails).some((item) => emailDomain(item) === domain);
}

function uniqueLeadId(leads: BarberLead[]): string | null {
  const ids = [...new Set(leads.map((lead) => String(lead.id)))];
  if (ids.length === 1) {
    return ids[0];
  }
  return null;
}

// Exact email wins. Domain is used only when the customer's domain is not
// free mail and exactly one lead matches that domain. Ambiguous matches
// return none so an order is not attached to the wrong barber.
export function matchBarberLead(
  customerEmail: string | null | undefined,
  leads: BarberLead[],
): MatchResult {
  const email = normalizeEmail(customerEmail);
  if (!email) {
    return { leadId: null, reason: "none" };
  }

  const emailMatches = leads.filter((lead) => leadEmails(lead).includes(email));
  if (emailMatches.length > 0) {
    const leadId = uniqueLeadId(emailMatches);
    return { leadId, reason: leadId ? "email" : "none" };
  }

  const domain = emailDomain(email);
  if (!domain || isFreeMailDomain(domain)) {
    return { leadId: null, reason: "none" };
  }

  const domainMatches = leads.filter((lead) => leadMatchesDomain(lead, domain));
  const leadId = uniqueLeadId(domainMatches);
  if (!leadId) {
    return { leadId: null, reason: "none" };
  }
  return { leadId, reason: "domain" };
}
