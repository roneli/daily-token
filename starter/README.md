# {{name}}: The Daily Token

A daily digest of what landed in {{name}}, made by [daily-token](https://www.npmjs.com/package/daily-token).

- `project.json`: where the work comes from, when issues come out, how the pipeline is tuned.
- `system.json`: the project's parts, for the Digest and the Blueprint. `bunx daily-token project cartographer` redraws it.
- `brief.json` (optional): what the project is and what its words mean, so the digest explains them. `bunx daily-token project brief` drafts it from the repos' READMEs and docs; edit it by hand freely.
- `issues/<date>/`: one folder per issue. `data.json` is what was collected; `stories.json` and `reels.json` are what the agents made of it; `review.json` and `trace/` show how they were graded.

## Every day

`.github/workflows/daily.yml` makes the issue at the cutoff, checks it, {{publishes}}and commits it here.

## Locally

    bunx daily-token doctor                 is everything set up
    bunx daily-token run --date YYYY-MM-DD  make one day's issue
    bunx daily-token preview                read the issues on :5173
    bunx daily-token replay reels --date YYYY-MM-DD --set reels.reviewers=[]
                                            make one stage again and compare

## Upgrading

Bump `daily-token` in `package.json`. Every issue renders again with the new engine.
