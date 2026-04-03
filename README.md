# S3 Browser

A clean Express app to browse any S3 bucket with last-modified dates.

## Setup

```bash
npm install
```

## Configuration

Set these environment variables before starting:

| Variable | Description | Default |
|---|---|---|
| `S3_BUCKET` | Your bucket name | `your-bucket-name` |
| `AWS_REGION` | Bucket region | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key | from ~/.aws/credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | from ~/.aws/credentials |
| `PORT` | Port to listen on | `3000` |

### Option A — export in terminal
```bash
export S3_BUCKET=my-bucket
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
npm start
```

### Option B — .env file (recommended)
Create a `.env` file:
```
S3_BUCKET=my-bucket
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```
Then run with:
```bash
node --env-file=.env server.js
```

### Option C — AWS profile (if already configured)
If you have `~/.aws/credentials` set up, just set the bucket:
```bash
S3_BUCKET=my-bucket npm start
```

## Run

```bash
# Production
npm start

# Development (auto-restarts on change, Node 18+)
npm run dev
```

Then open http://localhost:3000

## IAM Permissions Required

Your AWS credentials need at minimum:
```json
{
  "Effect": "Allow",
  "Action": ["s3:ListBucket"],
  "Resource": "arn:aws:s3:::your-bucket-name"
}
```

## Note on "Last Accessed" Dates

S3 does not natively store last-access timestamps. This app shows `LastModified`
(the date the object was last uploaded/written). For true access tracking, enable
S3 Server Access Logging and parse the logs.
