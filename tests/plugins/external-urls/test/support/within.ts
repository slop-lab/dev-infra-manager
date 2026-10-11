export function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms`)), milliseconds);
    })
  ]);
}
