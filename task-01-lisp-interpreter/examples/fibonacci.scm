; 朴素递归斐波那契。预期结果：(fib 10) => 55

(define (fib n)
  (if (< n 2)
      n
      (+ (fib (- n 1)) (fib (- n 2)))))

(fib 10)
