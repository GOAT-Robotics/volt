# Backups

## What Volt stores, and where

Everything is in **one SQLite database** on the server's data volume (`/opt/volt/data/volt.db`, mounted at
`/app/data` in the container): projects, versions and their drawings (JSON), the original imported `.qet`
files, the element library, style/title block/project templates, reviews, comments, signatures, file
attachments and the audit trail. Nothing is kept in S3 or elsewhere.

The only other file is the signing key `signing-key.pem` (unless `SIGNING_PRIVATE_KEY` is set in `.env`).

## Automatic backups to S3

With `BACKUP_S3_BUCKET` set, Volt takes a consistent snapshot of the live database every
`BACKUP_INTERVAL_HOURS` (default 6), gzips it and uploads it:

```
s3://<bucket>/<prefix>YYYY/MM/volt-<timestamp>.db.gz        the database
s3://<bucket>/<prefix>YYYY/MM/volt-<timestamp>.db.gz.json   size + SHA-256 of the uncompressed file
```

- The snapshot uses SQLite `VACUUM INTO`, so it is consistent while people keep working; the upload
  streams, so memory use stays small.
- Encrypted at rest with SSE-S3 (AES-256), or SSE-KMS with `BACKUP_S3_KMS_KEY_ID`.
- Backups older than `BACKUP_KEEP_DAYS` (default 30) are deleted; the newest 7 are always kept.
- Administration → Retention shows the last backup, recent runs (and errors), and **Back up now**.
- A failed run is retried after 30 minutes.

### Bucket setup (once)

1. Create a private bucket (Block Public Access on), in the server's region.
2. Turn on **Versioning** and, ideally, a lifecycle rule that expires noncurrent versions after 30 days —
   this protects backups against accidental or malicious deletion by the app's own credentials.
3. Create an IAM user or instance role for the server with only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::BUCKET/volt/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::BUCKET", "Condition": { "StringLike": { "s3:prefix": "volt/*" } } }
  ]
}
```

   (add `kms:GenerateDataKey` on the key when using SSE-KMS).
4. In the server's `.env`:

```
BACKUP_S3_BUCKET=your-bucket
AWS_ACCESS_KEY_ID=...        # not needed with an instance role
AWS_SECRET_ACCESS_KEY=...
```

   then `docker compose up -d`. The log shows `[backup] every 6 h to s3://…`.

The signing key is **not** uploaded by default. Keep a copy of `signing-key.pem` (or the
`SIGNING_PRIVATE_KEY` value) in your password manager; set `BACKUP_INCLUDE_SIGNING_KEY=1` only if the
bucket is as well protected as the key must be.

## Restore

On the server (needs the AWS CLI):

```
scripts/restore-backup.sh s3://your-bucket/volt/2026/09/volt-2026-09-27T07-14-27-397Z.db.gz
```

It downloads the backup, checks its SHA-256 and SQLite integrity, stops Volt, keeps the current
database as `volt.db.before-restore-<time>`, puts the backup in place and starts Volt again.
