; 线性递归阶乘。预期结果：(factorial 10) => 3628800

(define (factorial n)
  (if (= n 0)
      1
      (* n (factorial (- n 1)))))

(factorial 10)
