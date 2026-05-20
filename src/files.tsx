import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Icon,
  List,
  Toast,
  confirmAlert,
  environment,
  showToast,
} from "@raycast/api";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { usePromise } from "@raycast/utils";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getR2Config } from "./r2";

type BucketFile = {
  key: string;
  size: number;
  lastModified?: string;
};

function getFileName(key: string) {
  return key.split("/").filter(Boolean).at(-1) ?? "download";
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getUniquePath(directory: string, fileName: string) {
  const extensionIndex = fileName.lastIndexOf(".");
  const name = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : "";
  let candidate = join(directory, fileName);
  let counter = 1;

  while (await pathExists(candidate)) {
    candidate = join(directory, `${name} ${counter}${extension}`);
    counter += 1;
  }

  return candidate;
}

async function downloadFile(key: string, directory: string) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Downloading",
    message: key,
  });

  try {
    await mkdir(directory, { recursive: true });

    const { bucket, client } = getR2Config();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error("File is empty or could not be downloaded.");
    }

    const bytes = await response.Body.transformToByteArray();
    const destination = await getUniquePath(directory, getFileName(key));
    await writeFile(destination, bytes);

    toast.style = Toast.Style.Success;
    toast.title = "Downloaded";
    toast.message = destination;

    return destination;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Download Failed";
    toast.message = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function copyFile(key: string) {
  const destination = await downloadFile(key, join(environment.supportPath, "clipboard"));
  await Clipboard.copy({ file: destination });
  await showToast({
    style: Toast.Style.Success,
    title: "Copied",
    message: getFileName(key),
  });
}

async function deleteFile(key: string) {
  if (
    !(await confirmAlert({
      title: "Delete File?",
      message: `This will permanently delete ${key} from the bucket.`,
      icon: Icon.Trash,
      primaryAction: {
        title: "Delete",
        style: Alert.ActionStyle.Destructive,
      },
    }))
  ) {
    return false;
  }

  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Deleting",
    message: key,
  });

  try {
    const { bucket, client } = getR2Config();
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    toast.style = Toast.Style.Success;
    toast.title = "Deleted";
    toast.message = key;

    return true;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Delete Failed";
    toast.message = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function listBucketFiles() {
  const { bucket, client } = getR2Config();

  const files: BucketFile[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of response.Contents ?? []) {
      if (!object.Key) {
        continue;
      }

      files.push({
        key: object.Key,
        size: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString(),
      });
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return files.sort((a, b) => {
    const dateComparison = (Date.parse(b.lastModified ?? "") || 0) - (Date.parse(a.lastModified ?? "") || 0);
    return dateComparison || a.key.localeCompare(b.key);
  });
}

function formatBytes(bytes: number) {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(date?: string) {
  if (!date) {
    return undefined;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(date));
}

export default function Command() {
  const { data: files = [], isLoading, revalidate } = usePromise(listBucketFiles);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search files">
      {files.length === 0 && !isLoading ? <List.EmptyView title="No files found" /> : null}
      {files.map((file) => (
        <List.Item
          key={file.key}
          title={file.key}
          accessories={[{ text: formatBytes(file.size) }, { text: formatDate(file.lastModified) }]}
          actions={
            <ActionPanel>
              <ActionPanel.Section title="Save">
                <Action
                  title="Download"
                  icon={Icon.Download}
                  onAction={() => downloadFile(file.key, join(homedir(), "Downloads"))}
                />
                <Action title="Copy" icon={Icon.Clipboard} onAction={() => copyFile(file.key)} />
              </ActionPanel.Section>
              <ActionPanel.Section title="Danger">
                <Action
                  title="Delete"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={async () => {
                    if (await deleteFile(file.key)) {
                      revalidate();
                    }
                  }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
