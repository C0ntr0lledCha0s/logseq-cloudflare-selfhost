/**
 * The body of an HTML form POST, or undefined when the request is not a form (wrong or missing
 * content type) or its body does not parse. Client input, so it is a 400, never a 500.
 */
export async function readForm(request: Request): Promise<FormData | undefined> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded") && !contentType.startsWith("multipart/form-data")) {
    return undefined;
  }
  try {
    return await request.formData();
  } catch {
    return undefined;
  }
}
