/**
 * SQL for the kyc tables: rows <-> KycCase / OnboardingStageRecord entities.
 */
import { nextSeq, type Db } from '../../db/index.js'

export type CaseOutcome = 'NOT_EXECUTED' | 'REJECTED' | 'WARNING' | 'PASSED'
export type ConsentObtained = 'yes' | 'no' | 'na'
/** OnboardingFailedEventDto.state (webhook spec) — the stage vocabulary shared with the customers domain. */
export type OnboardingStage = 'DOCUMENT_SCAN' | 'SANCTIONS_SCAN' | 'KYC_AML_SCAN' | 'DUPLICATE_CHECK'
export type StageResult = 'FAILED' | 'APPROVED'

export interface KycCase {
  id: string
  customerId?: string
  outcome: CaseOutcome
  /** ExternalCase.timestamp — creation instant. */
  createdAt: string
  consentObtained?: ConsentObtained
  consentObtainedAt?: string
  userIp?: string
  userLocationCountry: string
  userLocationState?: string
  mobileToken: string
  webLink: string
}

export interface OnboardingStageRecord {
  customerId: string
  stage: OnboardingStage
  result: StageResult
  submissionFailure: boolean
  comments?: string
  failedAt?: string
  approvedAt?: string
}

export class KycRepo {
  constructor(private readonly db: Db) {}

  insertCase(c: KycCase): void {
    this.db
      .prepare(
        `INSERT INTO kyc_cases(id, seq, customer_id, outcome, created_at, consent_obtained, consent_obtained_at, user_ip, user_location_country, user_location_state, mobile_token, web_link)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(c.id, nextSeq(this.db, 'kyc_case'), c.customerId ?? null, c.outcome, c.createdAt, c.consentObtained ?? null, c.consentObtainedAt ?? null, c.userIp ?? null, c.userLocationCountry, c.userLocationState ?? null, c.mobileToken, c.webLink)
  }

  caseById(id: string): KycCase | undefined {
    const r = this.db.prepare('SELECT * FROM kyc_cases WHERE id = ?').get(id) as CaseRow | undefined
    return r ? caseFromRow(r) : undefined
  }

  /** Cases linked to the customer, creation order. */
  casesForCustomer(customerId: string): KycCase[] {
    return (this.db.prepare('SELECT * FROM kyc_cases WHERE customer_id = ? ORDER BY seq ASC').all(customerId) as CaseRow[]).map(caseFromRow)
  }

  /** Sets customer_id on an unlinked case; returns whether a row changed. */
  linkCase(caseId: string, customerId: string): boolean {
    return this.db.prepare('UPDATE kyc_cases SET customer_id = ? WHERE id = ? AND customer_id IS NULL').run(customerId, caseId).changes > 0
  }

  /** Moves a NOT_EXECUTED case to its verdict; returns whether a row changed. */
  setOutcome(caseId: string, outcome: CaseOutcome): boolean {
    return this.db.prepare(`UPDATE kyc_cases SET outcome = ? WHERE id = ? AND outcome = 'NOT_EXECUTED'`).run(outcome, caseId).changes > 0
  }

  stagesFor(customerId: string): OnboardingStageRecord[] {
    return (this.db.prepare('SELECT * FROM kyc_onboarding_stages WHERE customer_id = ? ORDER BY seq ASC').all(customerId) as StageRow[]).map(stageFromRow)
  }

  stage(customerId: string, stage: OnboardingStage): OnboardingStageRecord | undefined {
    const r = this.db.prepare('SELECT * FROM kyc_onboarding_stages WHERE customer_id = ? AND stage = ?').get(customerId, stage) as StageRow | undefined
    return r ? stageFromRow(r) : undefined
  }

  /** Inserts or replaces the stage record (keeps the record order of the first insert). */
  saveStage(s: OnboardingStageRecord): void {
    const existing = this.db.prepare('SELECT seq FROM kyc_onboarding_stages WHERE customer_id = ? AND stage = ?').get(s.customerId, s.stage) as { seq: number } | undefined
    this.db
      .prepare(
        `INSERT OR REPLACE INTO kyc_onboarding_stages(customer_id, stage, seq, result, submission_failure, comments, failed_at, approved_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(s.customerId, s.stage, existing?.seq ?? nextSeq(this.db, 'kyc_stage'), s.result, s.submissionFailure ? 1 : 0, s.comments ?? null, s.failedAt ?? null, s.approvedAt ?? null)
  }
}

type CaseRow = Record<string, unknown>
type StageRow = Record<string, unknown>

const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v))

function caseFromRow(r: CaseRow): KycCase {
  const c: KycCase = {
    id: r.id as string,
    outcome: r.outcome as CaseOutcome,
    createdAt: r.created_at as string,
    userLocationCountry: r.user_location_country as string,
    mobileToken: r.mobile_token as string,
    webLink: r.web_link as string,
  }
  const opt: [keyof KycCase, unknown][] = [
    ['customerId', r.customer_id], ['consentObtained', r.consent_obtained], ['consentObtainedAt', r.consent_obtained_at],
    ['userIp', r.user_ip], ['userLocationState', r.user_location_state],
  ]
  for (const [k, v] of opt) if (v !== null && v !== undefined) (c as unknown as Record<string, unknown>)[k] = v
  return c
}

function stageFromRow(r: StageRow): OnboardingStageRecord {
  const s: OnboardingStageRecord = {
    customerId: r.customer_id as string,
    stage: r.stage as OnboardingStage,
    result: r.result as StageResult,
    submissionFailure: r.submission_failure === 1,
  }
  const comments = str(r.comments)
  const failedAt = str(r.failed_at)
  const approvedAt = str(r.approved_at)
  if (comments !== undefined) s.comments = comments
  if (failedAt !== undefined) s.failedAt = failedAt
  if (approvedAt !== undefined) s.approvedAt = approvedAt
  return s
}
