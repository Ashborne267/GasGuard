# Release Artifact Retention Policy

## GitHub Actions Artifacts

Temporary artifacts produced by release workflows are retained for 90 days. The release SBOM workflow sets `retention-days: 90` on its uploaded artifact. A test parses the workflow and fails if a release artifact upload omits or changes that retention period.

Temporary workflow artifacts are for verification and recovery during the release window; they are not the archival copy of a release.

## Published Release Assets

Files attached to a published GitHub Release remain available for as long as that release exists. GasGuard does not automatically delete or expire published release assets. Repository maintainers handle release deletion or replacement through the normal release process.

## Dependencies and Troubleshooting

This policy relies on GitHub Actions artifact retention and GitHub Releases storage. If an Actions artifact expires, retrieve the corresponding SBOM from the published release assets. If release assets are unavailable, verify the release was published and that the workflow had `contents: write` permission.