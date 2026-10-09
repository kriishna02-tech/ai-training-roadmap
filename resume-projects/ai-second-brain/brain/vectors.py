from threading import RLock

from qdrant_client import QdrantClient, models


class VectorStore:
    def __init__(self, settings, provider, client=None):
        self.client = client or (
            QdrantClient(url=settings.qdrant_url,
                         api_key=settings.qdrant_api_key.get_secret_value() or None)
            if settings.qdrant_url else
            QdrantClient(path=str(settings.data_dir / "vectors"), force_disable_check_same_thread=True)
        )
        self.collection = f"memories_{provider.name}_{provider.dimensions}"
        self.lock = RLock()
        if not self.client.collection_exists(self.collection):
            self.client.create_collection(self.collection, vectors_config=models.VectorParams(
                size=provider.dimensions, distance=models.Distance.COSINE))

    def put(self, owner, memories, embeddings):
        with self.lock:
            self.client.upsert(self.collection, wait=True, points=[models.PointStruct(
                id=m["id"], vector=v, payload={"owner": owner})
                for m, v in zip(memories, embeddings, strict=True)])

    def search(self, owner, vector, limit):
        with self.lock:
            result = self.client.query_points(
                collection_name=self.collection, query=vector, limit=limit,
                query_filter=models.Filter(must=[models.FieldCondition(
                    key="owner", match=models.MatchValue(value=owner))]), score_threshold=0.1)
            return [str(item.id) for item in result.points]

    def close(self):
        self.client.close()
