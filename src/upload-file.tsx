import { Action, ActionPanel, Clipboard, Detail, Form, Toast, getSelectedFinderItems, showToast } from "@raycast/api";
import { Upload } from "@aws-sdk/lib-storage";
import { basename } from "node:path";
import { createReadStream } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { stat } from "node:fs/promises";
import { useEffect, useRef, useState } from "react";
import { getR2Config } from "./r2";

type FormValues = {
  files: string[];
};

type UploadMode = "checking" | "manual" | "uploading" | "done";
type UploadSource = "Finder" | "Clipboard" | "File Picker";

type InitialUpload = {
  path: string;
  source: UploadSource;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(path: string) {
  const trimmedPath = path.trim().replace(/^['"]|['"]$/g, "");

  if (trimmedPath.startsWith("file://")) {
    return decodeURIComponent(new URL(trimmedPath).pathname);
  }

  return trimmedPath;
}

async function getClipboardPath() {
  const clipboard = await Clipboard.read();
  const clipboardPath = clipboard.file ?? clipboard.text;

  return clipboardPath ? normalizePath(clipboardPath) : undefined;
}

async function validateFilePath(path: string) {
  const normalizedPath = normalizePath(path);

  if (!normalizedPath) {
    throw new Error("Not a file path.");
  }

  let fileStats;

  try {
    fileStats = await stat(normalizedPath);
  } catch {
    throw new Error("Not a file path.");
  }

  if (!fileStats.isFile()) {
    throw new Error("Not a file.");
  }

  return { path: normalizedPath, size: fileStats.size };
}

async function uploadFile(path: string, source: UploadSource) {
  const normalizedPath = normalizePath(path);
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Preparing",
    message: `${source}: ${basename(normalizedPath)}`,
  });

  try {
    const file = await validateFilePath(normalizedPath);
    const key = basename(file.path);
    const { bucket, client } = getR2Config();
    let lastPercent = -1;

    toast.title = "0%";
    toast.message = `Uploading ${key}`;

    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: createReadStream(file.path),
        ContentLength: file.size,
      },
    });

    upload.on("httpUploadProgress", (progress) => {
      const total = progress.total ?? file.size;

      if (!total) {
        return;
      }

      const percent = Math.min(100, Math.floor(((progress.loaded ?? 0) / total) * 100));

      if (percent !== lastPercent) {
        toast.title = `${percent}%`;
        toast.message = `Uploading ${key}`;
        lastPercent = percent;
      }
    });

    await upload.done();

    toast.title = "Processing";
    toast.message = key;
    await setTimeout(300);

    toast.style = Toast.Style.Success;
    toast.title = "Complete";
    toast.message = key;

    return true;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = getErrorMessage(error).startsWith("Not a") ? getErrorMessage(error) : "Upload Failed";
    toast.message = getErrorMessage(error).startsWith("Not a") ? source : getErrorMessage(error);

    return false;
  }
}

async function getInitialUpload(): Promise<InitialUpload | undefined> {
  if (process.platform === "darwin") {
    try {
      const selectedItems = await getSelectedFinderItems();
      const selectedItem = selectedItems[0];

      if (selectedItem) {
        return { path: selectedItem.path, source: "Finder" };
      }
    } catch {
      // Fall back to the form when Finder isn't frontmost or doesn't expose a selection.
    }
  }

  const clipboardPath = await getClipboardPath();

  if (!clipboardPath) {
    return undefined;
  }

  try {
    await validateFilePath(clipboardPath);
    return { path: clipboardPath, source: "Clipboard" };
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: "Not a File Path",
      message: "Choose a file manually instead.",
    });
    return undefined;
  }
}

export default function Command() {
  const didTryInitialUpload = useRef(false);
  const [files, setFiles] = useState<string[]>([]);
  const [mode, setMode] = useState<UploadMode>("checking");
  const [statusMessage, setStatusMessage] = useState("Looking for a selected or copied file…");

  useEffect(() => {
    if (didTryInitialUpload.current) {
      return;
    }

    didTryInitialUpload.current = true;

    async function uploadInitialFile() {
      const initialUpload = await getInitialUpload();

      if (!initialUpload) {
        setMode("manual");
        return;
      }

      setFiles([initialUpload.path]);
      setMode("uploading");
      setStatusMessage(`Uploading ${initialUpload.path}`);

      const didUpload = await uploadFile(initialUpload.path, initialUpload.source);

      setMode("done");
      setStatusMessage(didUpload ? "Upload complete." : "Upload failed. Check the toast for details.");
    }

    uploadInitialFile();
  }, []);

  async function handleSubmit(values: FormValues) {
    const path = values.files[0];

    if (!path) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Not a File Path",
        message: "Choose a file to upload.",
      });
      return;
    }

    await uploadFile(path, "File Picker");
  }

  if (mode !== "manual") {
    return <Detail isLoading={mode === "checking" || mode === "uploading"} markdown={statusMessage} />;
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Upload File" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description text="If no Finder selection or valid clipboard file path is found, choose a file here." />
      <Form.FilePicker id="files" title="File" value={files} onChange={setFiles} allowMultipleSelection={false} />
    </Form>
  );
}
