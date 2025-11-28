"""
File operation utilities for backup and restore
"""

import os
import shutil
from datetime import datetime as dt


def create_backup(file_path: str) -> str:
    """
    Create a timestamped backup of a file.

    Args:
        file_path: Path to the file to backup

    Returns:
        Path to the backup file
    """
    timestamp = dt.now().strftime("%Y%m%d_%H%M%S")
    backup_path = file_path.replace(".ods", f"_backup_{timestamp}.ods")
    shutil.copy2(file_path, backup_path)
    print(f"Creating backup: {backup_path}")
    return backup_path


def restore_from_backup(backup_path: str, target_path: str) -> None:
    """
    Restore a file from its backup.

    Args:
        backup_path: Path to the backup file
        target_path: Path to restore to
    """
    print(f"Restoring from backup...")
    shutil.copy2(backup_path, target_path)
    print(f"✓ Restored from backup")


def remove_backup(backup_path: str) -> None:
    """
    Remove a backup file if it exists.

    Args:
        backup_path: Path to the backup file
    """
    if os.path.exists(backup_path):
        os.remove(backup_path)
        print(f"✓ Removed backup file")
