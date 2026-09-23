export function StatusMessage({
  message,
  tone = "error"
}: {
  message: string;
  tone?: "error" | "success" | "info";
}) {
  if (!message) {
    return null;
  }
  return (
    <p className={`status-message ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {message}
    </p>
  );
}
