// SPDX-License-Identifier: AGPL-3.0-only
export const failureLabel = 'scheduled-failure';

/** Report only a failed scheduled run on main. The caller supplies the workflow's overall failure. */
export async function reportScheduledFailure({ github, context, failed, dryRun = false, now = new Date() }) {
  if (!failed || context.eventName !== 'schedule' || context.ref !== 'refs/heads/main') return { action: 'skip' };

  const repo = context.repo;
  const title = `Scheduled workflow failed: ${context.workflow}`;
  const attempt = context.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? 1;
  const run = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}/attempts/${attempt}`;
  const body = `Workflow: ${context.workflow}\nRun: ${run}\nDate: ${now.toISOString().slice(0, 10)} (UTC)`;
  // Paginate the issue list rather than using the eventually consistent search index.
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo, state: 'open', labels: failureLabel, per_page: 100,
  });
  const issue = issues.find((candidate) => !candidate.pull_request && candidate.title === title);
  const plan = issue ? { action: 'comment', issue: issue.number, body } : { action: 'create', title, body, labels: [failureLabel] };
  if (dryRun) return plan;

  if (issue) {
    await github.rest.issues.createComment({ ...repo, issue_number: issue.number, body });
  } else {
    try {
      await github.rest.issues.getLabel({ ...repo, name: failureLabel });
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await github.rest.issues.createLabel({ ...repo, name: failureLabel, color: 'd73a4a' });
      } catch (creationError) {
        if (creationError.status !== 422) throw creationError;
        // Another workflow can create the shared label between our lookup and creation.
        await github.rest.issues.getLabel({ ...repo, name: failureLabel });
      }
    }
    await github.rest.issues.create({ ...repo, title, body, labels: [failureLabel] });
  }
  return plan;
}
