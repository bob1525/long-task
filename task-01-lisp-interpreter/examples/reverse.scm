; 用尾递归累加器反转列表。预期结果：(5 4 3 2 1)

(define (reverse xs)
  (define (rev xs acc)
    (if (null? xs)
        acc
        (rev (cdr xs) (cons (car xs) acc))))
  (rev xs '()))

(reverse '(1 2 3 4 5))
