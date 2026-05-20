import { S3Client } from "@aws-sdk/client-s3";
import { getPreferenceValues } from "@raycast/api";

type Preferences = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

function normalizeEndpoint(endpoint: string) {
  const url = new URL(endpoint.trim());

  url.pathname = "";
  url.search = "";
  url.hash = "";

  return url.toString();
}

export function getR2Config() {
  const preferences = getPreferenceValues<Preferences>();

  return {
    bucket: preferences.bucket.trim(),
    client: new S3Client({
      region: "auto",
      endpoint: normalizeEndpoint(preferences.endpoint),
      forcePathStyle: true,
      credentials: {
        accessKeyId: preferences.accessKeyId.trim(),
        secretAccessKey: preferences.secretAccessKey.trim(),
      },
    }),
  };
}
