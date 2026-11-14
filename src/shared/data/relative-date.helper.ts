/**
 * Deterministic relative date calculator for Insurance Risk Data Builders
 * (e.g., Policy Effective Date, Driver Date of Birth, Prior Claim Date).
 */
export class RelativeDateHelper {
  /**
   * Returns an ISO YYYY-MM-DD date offset by `daysOffset` from today (e.g. +14 for policy inception).
   */
  static daysFromToday(daysOffset: number, baseDate: Date = new Date()): string {
    const target = new Date(baseDate.getTime());
    target.setUTCDate(target.getUTCDate() + daysOffset);
    return target.toISOString().slice(0, 10);
  }

  /**
   * Returns an ISO YYYY-MM-DD date `years` in the past (e.g. driver DOB for age brackets or NCB years).
   */
  static yearsAgo(years: number, baseDate: Date = new Date()): string {
    const target = new Date(baseDate.getTime());
    target.setUTCFullYear(target.getUTCFullYear() - years);
    return target.toISOString().slice(0, 10);
  }

  /**
   * Returns an ISO YYYY-MM-DD date `months` in the past (e.g. prior motor/home claim date).
   */
  static monthsAgo(months: number, baseDate: Date = new Date()): string {
    const target = new Date(baseDate.getTime());
    target.setUTCMonth(target.getUTCMonth() - months);
    return target.toISOString().slice(0, 10);
  }
}
