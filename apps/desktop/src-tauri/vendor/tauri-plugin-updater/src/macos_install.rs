// SPDX-License-Identifier: Apache-2.0 OR MIT
// Fruit Truck patch for https://github.com/tauri-apps/plugins-workspace/issues/3505.
// Stage on the destination volume and atomically exchange complete bundles.
// Never move/delete the installed app before its replacement is in place.

use std::{
    ffi::CString,
    fs,
    io::{self, Cursor},
    os::unix::ffi::OsStrExt,
    path::Path,
    process::Command,
};

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn require_directory(path: &Path) -> io::Result<()> {
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err(invalid("The update bundle must be a real directory."));
    }
    Ok(())
}

fn verify_bundle(bundle: &Path) -> io::Result<()> {
    let result = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .output()?;
    if !result.status.success() {
        return Err(invalid(format!(
            "The replacement app failed signature verification. The installed app was retained: {}",
            String::from_utf8_lossy(&result.stderr)
        )));
    }
    Ok(())
}

fn exchange_bundles(staged: &Path, installed: &Path) -> io::Result<()> {
    let staged = CString::new(staged.as_os_str().as_bytes()).map_err(|e| invalid(e.to_string()))?;
    let installed =
        CString::new(installed.as_os_str().as_bytes()).map_err(|e| invalid(e.to_string()))?;
    // Both paths are real directories on the same volume. RENAME_SWAP leaves
    // both untouched on failure and never exposes a missing installation.
    let result =
        unsafe { libc::renamex_np(staged.as_ptr(), installed.as_ptr(), libc::RENAME_SWAP) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn install(bytes: &[u8], installed: &Path) -> io::Result<()> {
    install_with(bytes, installed, verify_bundle, exchange_bundles)
}

fn install_with(
    bytes: &[u8],
    installed: &Path,
    verify: impl FnOnce(&Path) -> io::Result<()>,
    exchange: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    require_directory(installed)?;
    let parent = installed
        .parent()
        .ok_or_else(|| invalid("The app has no installation directory."))?;
    // Permission failure stops here. Do not fall back to an administrator
    // script that deletes the original before moving the replacement.
    let staging = tempfile::Builder::new()
        .prefix(".fruit-truck-update-")
        .tempdir_in(parent)
        .map_err(|error| io::Error::new(error.kind(), format!(
            "Cannot stage an update beside the app. The installed app was retained. Install the new DMG manually: {error}"
        )))?;
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
    tar::Archive::new(decoder).unpack(staging.path())?;
    let entries = fs::read_dir(staging.path())?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() != 1 {
        return Err(invalid(
            "The update archive must contain exactly one app bundle.",
        ));
    }
    let bundle = entries[0].path();
    if bundle.extension().and_then(|value| value.to_str()) != Some("app") {
        return Err(invalid(
            "The update archive does not contain an app bundle.",
        ));
    }
    require_directory(&bundle)?;
    require_directory(&bundle.join("Contents"))?;
    require_directory(&bundle.join("Contents/MacOS"))?;
    if !fs::symlink_metadata(bundle.join("Contents/Info.plist"))?
        .file_type()
        .is_file()
    {
        return Err(invalid("The update bundle has no regular Info.plist."));
    }
    verify(&bundle)?;
    exchange(&bundle, installed).map_err(|error| io::Error::new(error.kind(), format!(
        "Atomic app replacement failed. The installed app was retained. Install the new DMG manually: {error}"
    )))?;
    // After a successful exchange the staging directory holds the old app.
    // TempDir cleanup is now safe. A crash before/after the exchange leaves
    // a complete old/new app at the installation path in either case.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive() -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for (path, content) in [
            ("Fruit Truck.app/Contents/Info.plist", "new plist"),
            ("Fruit Truck.app/Contents/MacOS/Fruit Truck", "new binary"),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive
                .append_data(&mut header, path, content.as_bytes())
                .unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }

    fn old_app(parent: &Path) -> std::path::PathBuf {
        let path = parent.join("Fruit Truck's app.app");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("old-binary"), "original").unwrap();
        path
    }

    #[test]
    fn failed_exchange_keeps_old_app_and_user_data() {
        for code in [
            libc::EACCES,
            libc::EXDEV,
            libc::ENOSPC,
            libc::ENOTSUP,
            libc::EIO,
        ] {
            let root = tempfile::tempdir().unwrap();
            let installed = old_app(root.path());
            let data = root.path().join("workspace.json");
            fs::write(&data, "sessions and assets").unwrap();
            let error = install_with(
                &archive(),
                &installed,
                |_| Ok(()),
                |_, old| {
                    assert_eq!(fs::read(old.join("old-binary")).unwrap(), b"original");
                    Err(io::Error::from_raw_os_error(code))
                },
            )
            .unwrap_err();
            assert!(error.to_string().contains("installed app was retained"));
            assert_eq!(fs::read(installed.join("old-binary")).unwrap(), b"original");
            assert_eq!(fs::read(data).unwrap(), b"sessions and assets");
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
        }
    }

    #[test]
    fn atomic_exchange_installs_complete_bundle_and_preserves_workspace() {
        let root = tempfile::tempdir().unwrap();
        let installed = old_app(root.path());
        let workspace = root.path().join("workspace.json");
        fs::write(&workspace, "sessions and assets").unwrap();
        install_with(
            &archive(),
            &installed,
            |_| Ok(()),
            |new, old| {
                assert_eq!(new.parent().unwrap().parent().unwrap(), root.path());
                exchange_bundles(new, old)?;
                assert_eq!(fs::read(new.join("old-binary"))?, b"original");
                assert_eq!(
                    fs::read(old.join("Contents/MacOS/Fruit Truck"))?,
                    b"new binary"
                );
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            fs::read(installed.join("Contents/MacOS/Fruit Truck")).unwrap(),
            b"new binary"
        );
        assert_eq!(fs::read(workspace).unwrap(), b"sessions and assets");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[test]
    fn invalid_archive_or_signature_never_changes_installation() {
        let root = tempfile::tempdir().unwrap();
        let installed = old_app(root.path());
        assert!(install(b"broken archive", &installed).is_err());
        assert!(install(&archive(), &installed).is_err());
        assert_eq!(fs::read(installed.join("old-binary")).unwrap(), b"original");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn actual_exchange_failure_leaves_existing_app_untouched() {
        let root = tempfile::tempdir().unwrap();
        let installed = old_app(root.path());
        assert!(exchange_bundles(&root.path().join("missing.app"), &installed).is_err());
        assert_eq!(fs::read(installed.join("old-binary")).unwrap(), b"original");
    }

    #[test]
    #[ignore = "requires FRUIT_TRUCK_TEST_SIGNED_ARCHIVE pointing to a published signed archive"]
    fn published_signed_bundle_installs_in_isolation() {
        let archive =
            std::env::var_os("FRUIT_TRUCK_TEST_SIGNED_ARCHIVE").expect("signed archive path");
        let bytes = fs::read(archive).unwrap();
        let root = tempfile::tempdir().unwrap();
        let installed = old_app(root.path());
        let workspace = root.path().join("workspace.json");
        fs::write(&workspace, "retained sessions and asset references").unwrap();
        install(&bytes, &installed).unwrap();
        verify_bundle(&installed).unwrap();
        assert!(installed.join("Contents/MacOS/Fruit Truck").is_file());
        assert_eq!(
            fs::read(&workspace).unwrap(),
            b"retained sessions and asset references"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[test]
    fn symlink_installation_is_not_replaced() {
        let root = tempfile::tempdir().unwrap();
        let installed = old_app(root.path());
        let link = root.path().join("linked.app");
        std::os::unix::fs::symlink(&installed, &link).unwrap();
        assert!(install(&archive(), &link).is_err());
        assert_eq!(fs::read(installed.join("old-binary")).unwrap(), b"original");
    }
}
