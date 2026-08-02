export function s3ConfigFormValues(form) {
  return {
    name: form.querySelector("#s3-config-name")?.value ?? "",
    endpoint: form.querySelector("#s3-config-endpoint")?.value ?? "",
    region: form.querySelector("#s3-config-region")?.value ?? "us-east-1",
    bucket: form.querySelector("#s3-config-bucket")?.value ?? "",
    prefix: form.querySelector("#s3-config-prefix")?.value ?? "",
    forcePathStyle: form.querySelector("#s3-config-force-path")?.checked ?? false,
    accessKeyId: form.querySelector("#s3-config-ak")?.value ?? "",
    secretAccessKey: form.querySelector("#s3-config-sk")?.value ?? ""
  };
}

export function s3ConfigPayload(values, isCreate) {
  const payload = {
    name: values.name,
    endpoint: values.endpoint,
    region: values.region,
    bucket: values.bucket,
    prefix: values.prefix,
    forcePathStyle: values.forcePathStyle
  };
  if (isCreate || (values.accessKeyId && values.accessKeyId.trim())) {
    payload.accessKeyId = values.accessKeyId;
  }
  if (isCreate || (values.secretAccessKey && values.secretAccessKey.trim())) {
    payload.secretAccessKey = values.secretAccessKey;
  }
  return payload;
}

export function s3SettingsFormValues(form) {
  return {
    scheduleHour: Number(form.querySelector("#s3-schedule-hour")?.value ?? 3),
    includeImages: form.querySelector("#s3-include-images")?.checked ?? true,
    retentionCount: Number(form.querySelector("#s3-retention-count")?.value ?? 10)
  };
}

export function s3SettingsPayload(values) {
  return {
    scheduleHour: values.scheduleHour,
    includeImages: values.includeImages,
    retentionCount: values.retentionCount
  };
}

export function s3StatusLabel(status) {
  if (status === "success") return "最近成功";
  if (status === "failed") return "最近失败";
  return "未执行";
}

export function s3StatusClass(status) {
  if (status === "success") return "is-success";
  if (status === "failed") return "is-failed";
  return "is-unknown";
}
