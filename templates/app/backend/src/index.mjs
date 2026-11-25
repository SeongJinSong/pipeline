// __APP_NAME__ 백엔드 (AWS Lambda, Node.js 22, API Gateway HTTP API)
// DynamoDB 단일 테이블: pk / sk. 테이블 이름은 TABLE_NAME 환경변수.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";

  if (path === "/health") return json(200, { ok: true, app: "__APP_SLUG__" });

  // 예시 리소스: /items  (Slack에서 요구사항을 주면 에이전트가 실제 도메인에 맞게 바꾼다)
  if (path === "/items" && method === "GET") {
    const out = await db.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "item" },
      }),
    );
    return json(200, { items: out.Items ?? [] });
  }
  if (path === "/items" && method === "POST") {
    const body = JSON.parse(event.body ?? "{}");
    const item = { pk: "item", sk: crypto.randomUUID(), createdAt: new Date().toISOString(), ...body };
    await db.send(new PutCommand({ TableName: TABLE, Item: item }));
    return json(201, item);
  }
  if (path.startsWith("/items/") && method === "GET") {
    const out = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: "item", sk: path.slice(7) } }));
    return out.Item ? json(200, out.Item) : json(404, { error: "not found" });
  }
  return json(404, { error: "not found" });
};
