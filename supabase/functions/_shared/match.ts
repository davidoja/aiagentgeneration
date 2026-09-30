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

// Mirrors public.normalize_domain(): lowercase, strip a leading http(s)://
// and one www. label, then drop the path. A bare www. host is left as-is,
// which is what that SQL function does.
export function normalizeDomain(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  let domain = value.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\/(www\.)?/, "");
  domain = domain.replace(/\/.*$/, "");
  return domain || null;
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

export type PartyContact = {
  id: string;
  email: string | null;
  organizationIds?: string[];
};

export type PartyBarber = {
  id: string;
  email: string | null;
  organizationId: string | null;
  name: string;
  country: string;
};

export type PartyOrganization = {
  id: string;
  displayName: string;
  legalName?: string | null;
  domains: string[];
  countryCodes: string[];
};

export type PartyCatalog = {
  contacts: PartyContact[];
  barbers: PartyBarber[];
  organizations: PartyOrganization[];
  leads?: BarberLead[];
};

export type PartyMatch = {
  contactId: string | null;
  barberId: string | null;
  organizationId: string | null;
  apifyLeadId: string | null;
  reason: "email" | "domain" | "company" | "none";
};

const EMPTY_MATCH: PartyMatch = {
  contactId: null,
  barberId: null,
  organizationId: null,
  apifyLeadId: null,
  reason: "none",
};

export function normalizeCompanyName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const name = value.trim().toLowerCase().replace(/\s+/g, " ");
  return name.length >= 2 ? name : null;
}

export function normalizeCountryCode(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const country = value.trim().toUpperCase();
  return country || null;
}

function uniqueIds(ids: string[]): string | null {
  const distinct = [...new Set(ids)];
  return distinct.length === 1 ? distinct[0] : null;
}

function orgDomains(org: PartyOrganization): string[] {
  return org.domains
    .map((domain) => normalizeDomain(domain))
    .filter((domain): domain is string => domain !== null);
}

function orgMatchesCompany(org: PartyOrganization, company: string, country: string): boolean {
  const names = [org.displayName, org.legalName ?? ""]
    .map((name) => normalizeCompanyName(name))
    .filter((name): name is string => name !== null);
  if (!names.includes(company)) {
    return false;
  }
  return org.countryCodes.some((code) => normalizeCountryCode(code) === country);
}

// Exact email on contacts and barbers, then normalize_domain() against
// organizations when the domain is not free mail, then one company-name
// plus country hit. Ambiguous steps do not guess.
export function matchParty(
  emailInput: string | null | undefined,
  companyInput: string | null | undefined,
  countryInput: string | null | undefined,
  catalog: PartyCatalog,
): PartyMatch {
  const email = normalizeEmail(emailInput);
  const result: PartyMatch = { ...EMPTY_MATCH };
  const apify = matchBarberLead(email, catalog.leads ?? []);
  if (apify.reason === "email") {
    result.apifyLeadId = apify.leadId;
  }

  const contacts = email
    ? catalog.contacts.filter((contact) => normalizeEmail(contact.email) === email)
    : [];
  const contactId = uniqueIds(contacts.map((contact) => contact.id));
  const barbers = email
    ? catalog.barbers.filter((barber) => normalizeEmail(barber.email) === email)
    : [];

  if (barbers.length > 1) {
    result.contactId = contactId;
    return result;
  }

  if (barbers.length === 1) {
    result.contactId = contactId;
    result.barberId = barbers[0].id;
    result.organizationId = barbers[0].organizationId;
    result.reason = "email";
    return result;
  }

  if (contactId) {
    result.contactId = contactId;
    result.reason = "email";
    const linked = contacts.flatMap((contact) => contact.organizationIds ?? []);
    result.organizationId = uniqueIds(linked);
    if (result.organizationId) {
      return result;
    }
  }

  const domain = email ? emailDomain(email) : null;
  const normalizedDomain = domain ? normalizeDomain(domain) : null;
  if (!result.barberId && !result.organizationId && normalizedDomain && !isFreeMailDomain(normalizedDomain)) {
    const orgs = catalog.organizations.filter((org) => orgDomains(org).includes(normalizedDomain));
    const organizationId = uniqueIds(orgs.map((org) => org.id));
    if (organizationId) {
      result.organizationId = organizationId;
      result.reason = result.contactId ? "email" : "domain";
      const orgBarbers = catalog.barbers.filter((barber) => barber.organizationId === organizationId);
      if (orgBarbers.length === 1) {
        result.barberId = orgBarbers[0].id;
      }
      return result;
    }
  }

  if (result.barberId || result.organizationId) {
    return result;
  }

  const company = normalizeCompanyName(companyInput);
  const country = normalizeCountryCode(countryInput);
  if (!company || !country) {
    return result;
  }

  const namedBarbers = catalog.barbers.filter((barber) =>
    normalizeCompanyName(barber.name) === company && normalizeCountryCode(barber.country) === country
  );
  const namedOrgs = catalog.organizations.filter((org) => orgMatchesCompany(org, company, country));
  const barberId = uniqueIds(namedBarbers.map((barber) => barber.id));
  const organizationId = uniqueIds(namedOrgs.map((org) => org.id));

  if (namedBarbers.length > 1 || namedOrgs.length > 1) {
    return result;
  }
  if (barberId && organizationId) {
    const barberOrg = namedBarbers[0].organizationId;
    if (barberOrg && barberOrg !== organizationId) {
      return result;
    }
    result.barberId = barberId;
    result.organizationId = barberOrg ?? organizationId;
    result.reason = result.reason === "none" ? "company" : result.reason;
    return result;
  }
  if (barberId) {
    result.barberId = barberId;
    result.organizationId = namedBarbers[0].organizationId;
    result.reason = result.reason === "none" ? "company" : result.reason;
    return result;
  }
  if (organizationId) {
    result.organizationId = organizationId;
    const orgBarbers = catalog.barbers.filter((barber) => barber.organizationId === organizationId);
    if (orgBarbers.length === 1) {
      result.barberId = orgBarbers[0].id;
    }
    result.reason = result.reason === "none" ? "company" : result.reason;
  }
  return result;
}
