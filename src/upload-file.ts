import { Clipboard, Toast, getSelectedFinderItems, showToast } from "@raycast/api";
import { Upload } from "@aws-sdk/lib-storage";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { basename } from "node:path";
import { createReadStream } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { stat } from "node:fs/promises";
import { getR2Config } from "./r2";

type UploadSource = "Finder" | "Clipboard";

type InitialUpload = {
  path: string;
  source: UploadSource;
};

type InitialUploadResult = InitialUpload | { errorTitle: string; errorMessage: string } | undefined;

class FileAlreadyExistsError extends Error {
  constructor(readonly key: string) {
    super("File Already Exists");
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const metadata = "$metadata" in error ? (error.$metadata as { httpStatusCode?: number }) : undefined;

  return metadata?.httpStatusCode === 404 || error.name === "NotFound" || error.name === "NoSuchKey";
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

async function getInitialUpload(): Promise<InitialUploadResult> {
  if (process.platform === "darwin") {
    try {
      const selectedItems = await getSelectedFinderItems();
      const selectedItem = selectedItems[0];

      if (selectedItem) {
        return { path: selectedItem.path, source: "Finder" };
      }
    } catch {
      // Fall back to the clipboard when Finder isn't frontmost or doesn't expose a selection.
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
    return {
      errorTitle: "Not a File Path",
      errorMessage: "The clipboard does not contain a valid file path.",
    };
  }
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

    toast.title = "Checking";
    toast.message = key;

    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      throw new FileAlreadyExistsError(key);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

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
  } catch (error) {
    const message = getErrorMessage(error);

    toast.style = Toast.Style.Failure;
    toast.title = message.startsWith("Not a") || error instanceof FileAlreadyExistsError ? message : "Upload Failed";
    toast.message =
      error instanceof FileAlreadyExistsError ? error.key : message.startsWith("Not a") ? source : message;
  }
}

export default async function Command() {
  const initialUpload = await getInitialUpload();

  if (!initialUpload) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Not a File Path",
      message: "Select a file in Finder or copy a valid file path.",
    });
    return;
  }

  if ("errorTitle" in initialUpload) {
    await showToast({
      style: Toast.Style.Failure,
      title: initialUpload.errorTitle,
      message: initialUpload.errorMessage,
    });
    return;
  }

  await uploadFile(initialUpload.path, initialUpload.source);
}
