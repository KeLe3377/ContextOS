use anyhow::{anyhow, Context as _, Result};
use semver::Version;

pub(crate) const LATEST_RELEASE_PAGE: &str = "";

#[derive(Clone, Default)]
pub(crate) enum UpdateStatus {
    #[default]
    Idle,
    Checking,
    UpToDate {
        latest: String,
    },
    Available {
        latest: String,
    },
    Failed,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct UpdateInfo {
    pub latest_version: Version,
    pub update_available: bool,
}

fn evaluate_release(current_version: &str, tag_name: &str) -> Result<UpdateInfo> {
    let current = Version::parse(current_version)
        .with_context(|| format!("invalid current version {current_version:?}"))?;
    let latest_text = tag_name
        .strip_prefix('v')
        .or_else(|| tag_name.strip_prefix('V'))
        .unwrap_or(tag_name);
    let latest = Version::parse(latest_text)
        .with_context(|| format!("invalid GitHub release tag {tag_name:?}"))?;

    Ok(UpdateInfo {
        update_available: latest > current,
        latest_version: latest,
    })
}

/// Only called from the explicit Settings action. ContextOS never checks in the
/// background, so opening the app still performs no network request.
pub(crate) fn check_latest_release(_current_version: &str) -> Result<UpdateInfo> {
    Err(anyhow!(
        "ContextOS release repository is not configured for this build"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_release_is_available() {
        let info = evaluate_release("0.2.9", "v0.3.0").unwrap();
        assert_eq!(info.latest_version, Version::new(0, 3, 0));
        assert!(info.update_available);
    }

    #[test]
    fn current_or_older_release_is_not_an_update() {
        assert!(
            !evaluate_release("0.2.9", "v0.2.9")
                .unwrap()
                .update_available
        );
        assert!(
            !evaluate_release("0.3.0", "v0.2.9")
                .unwrap()
                .update_available
        );
    }

    #[test]
    fn malformed_release_tag_is_rejected() {
        assert!(evaluate_release("0.2.9", "latest").is_err());
    }

    #[test]
    fn release_check_is_disabled_without_a_contextos_repository() {
        assert!(check_latest_release("0.2.8").is_err());
    }
}
