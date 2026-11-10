; 闭包：加法器捕获 n，两个计数器各自拥有独立的 n。
; 输出依次为 8、13、1、2、1，最终结果 17。

(define (make-adder n)
  (lambda (x) (+ x n)))

(define add5 (make-adder 5))
(define add10 (make-adder 10))

(display (add5 3))
(newline)
(display (add10 3))
(newline)

(define (make-counter)
  (let ((n 0))
    (lambda ()
      (set! n (+ n 1))
      n)))

(define a (make-counter))
(define b (make-counter))

(display (a))
(newline)
(display (a))
(newline)
(display (b))
(newline)

(+ (add5 1) (add10 1))
