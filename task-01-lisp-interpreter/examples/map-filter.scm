; 手写 map 与 filter。
; 输出：(1 4 9 16)
; 结果：(2 4 6)

(define (map f xs)
  (if (null? xs)
      '()
      (cons (f (car xs)) (map f (cdr xs)))))

(define (filter pred xs)
  (if (null? xs)
      '()
      (if (pred (car xs))
          (cons (car xs) (filter pred (cdr xs)))
          (filter pred (cdr xs)))))

(define (square x)
  (* x x))

(define (even? x)
  (= (modulo x 2) 0))

(display (map square '(1 2 3 4)))
(newline)
(filter even? '(1 2 3 4 5 6))
