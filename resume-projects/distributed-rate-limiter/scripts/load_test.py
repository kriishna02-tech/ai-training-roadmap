"""python scripts/load_test.py --requests 200 --concurrency 20"""
import argparse
import asyncio
from collections import Counter
from time import perf_counter

import httpx


async def main(args):
    semaphore = asyncio.Semaphore(args.concurrency)
    async with httpx.AsyncClient(timeout=10) as client:
        async def request():
            async with semaphore:
                response = await client.get(f"{args.url}/v1/resource", headers={"X-API-Key": args.key})
                return response.status_code
        started = perf_counter()
        statuses = Counter(await asyncio.gather(*(request() for _ in range(args.requests))))
    print({"statuses": dict(statuses), "elapsed_seconds": round(perf_counter() - started, 3)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--key", default="local-demo-key")
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--concurrency", type=int, default=20)
    asyncio.run(main(parser.parse_args()))
