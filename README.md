# File Uploads

Manages uploaded files in a Cloudflare R2 bucket.

Configure the extension preferences with your R2 S3 API endpoint, Access Key ID, Secret Access Key, and bucket name. Use the account-level endpoint without the bucket path, for example `https://accountId.r2.cloudflarestorage.com`.

The `List Files` command fetches the bucket contents each time it opens and lists every object in the bucket, newest first.

The `Upload File` command uploads the selected Finder file on macOS. If there isn't a selected Finder file, or on Windows, it tries a valid file path from the clipboard and otherwise shows a file picker fallback.
