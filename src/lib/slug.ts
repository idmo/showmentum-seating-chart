import { randomBytes } from "node:crypto";

// An unguessable token used as an event's entire access control: there is
// no login, so this string IS the permission — anyone who has it can view
// and edit that one event, and only that event. 18 bytes -> 24 base64url
// chars, ~144 bits of entropy (way more than enough to make guessing
// infeasible), URL-safe with no padding.
export function generateShareSlug(): string {
  return randomBytes(18).toString("base64url");
}
