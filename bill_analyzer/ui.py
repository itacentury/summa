"""
User interface functions
"""

import os
import tkinter as tk
from tkinter import filedialog


def select_pdf_files() -> tuple[str, ...]:
    """
    Open a file dialog to let the user select PDF files.

    Returns:
        Tuple of selected file paths (empty if cancelled)
    """
    root = tk.Tk()
    root.withdraw()

    file_paths = filedialog.askopenfilenames(
        parent=root,
        title="Select Bills to Analyze",
        filetypes=[("PDF files", "*.pdf")],
        initialdir=os.path.expanduser("~/Downloads"),
    )

    return file_paths
