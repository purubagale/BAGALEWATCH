// Shared status/severity label tables for the Site/Sector Issue tracker
// (2026-09-14) -- same "pull the table out once so every page that needs
// the labels uses the exact same values" convention statusColor.ts
// already established for Site.status. Matches Issue.STATUS_CHOICES/
// SEVERITY_CHOICES on the backend (core/models.py) exactly.
import type { IssueSeverity, IssueStatus } from '../api/types'

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
}

export const ISSUE_STATUS_ORDER: IssueStatus[] = ['open', 'in_progress', 'resolved', 'closed']

export const ISSUE_SEVERITY_LABELS: Record<IssueSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}

export const ISSUE_SEVERITY_ORDER: IssueSeverity[] = ['low', 'medium', 'high', 'critical']
