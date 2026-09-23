module Gtd.Ranking exposing (ranksForOrder, step)

{-| The ranks that put items in an order, changing as few as possible.

This mirrors `ranksForOrder` in `src/domain/ranking.ts` step for step, including
which of several equally long runs it keeps, so a board can show a move before the
host has written it and recognise the snapshot that confirms it.

-}

import Array exposing (Array)
import Dict exposing (Dict)
import Set exposing (Set)


{-| Space left between neighbouring ranks.
-}
step : Int
step =
    1000


{-| Only the ranks that change, by id. Items keep a rank that already fits the
order; the rest are placed between their kept neighbours, and the whole list is
renumbered only when no integer is left between two of them.
-}
ranksForOrder : List ( String, Maybe Int ) -> Dict String Int
ranksForOrder list =
    let
        items =
            Array.fromList list

        kept =
            longestIncreasing items

        initial =
            Array.indexedMap
                (\index ( _, rank ) ->
                    if Set.member index kept then
                        rank

                    else
                        Nothing
                )
                items

        renumbered =
            List.indexedMap (\index _ -> (index + 1) * step) list
    in
    case fill 0 initial of
        Just ranks ->
            changed list (Array.toList ranks)

        Nothing ->
            changed list renumbered


changed : List ( String, Maybe Int ) -> List Int -> Dict String Int
changed items ranks =
    List.map2
        (\( id, current ) rank ->
            if current == Just rank then
                Nothing

            else
                Just ( id, rank )
        )
        items
        ranks
        |> List.filterMap identity
        |> Dict.fromList


{-| Fills each run of unranked slots from its neighbours, left to right, or gives
up when a run no longer fits between them.
-}
fill : Int -> Array (Maybe Int) -> Maybe (Array Int)
fill start assigned =
    if start >= Array.length assigned then
        Just (Array.map (Maybe.withDefault 0) assigned)

    else if Array.get start assigned |> Maybe.andThen identity |> (/=) Nothing then
        fill (start + 1) assigned

    else
        let
            end =
                runEnd start assigned

            count =
                end - start

            at index =
                Array.get index assigned |> Maybe.andThen identity

            low =
                if start > 0 then
                    at (start - 1)

                else
                    Nothing

            high =
                at end

            rankFor offset =
                case ( low, high ) of
                    ( Just lo, Just hi ) ->
                        lo + ((hi - lo) * (offset + 1)) // (count + 1)

                    ( Just lo, Nothing ) ->
                        lo + (offset + 1) * step

                    ( Nothing, Just hi ) ->
                        hi - (count - offset) * step

                    ( Nothing, Nothing ) ->
                        (offset + 1) * step

            tooTight =
                case ( low, high ) of
                    ( Just lo, Just hi ) ->
                        hi - lo <= count

                    _ ->
                        False
        in
        if tooTight then
            Nothing

        else
            fill end
                (List.foldl (\offset acc -> Array.set (start + offset) (Just (rankFor offset)) acc)
                    assigned
                    (List.range 0 (count - 1))
                )


runEnd : Int -> Array (Maybe Int) -> Int
runEnd index assigned =
    case Array.get index assigned of
        Just Nothing ->
            runEnd (index + 1) assigned

        _ ->
            index


{-| Indices of the longest run of existing ranks that already increase in list
order, found by patience sorting exactly as the host does.
-}
longestIncreasing : Array ( String, Maybe Int ) -> Set Int
longestIncreasing items =
    let
        rankAt index =
            Array.get index items |> Maybe.andThen Tuple.second |> Maybe.withDefault 0

        search rank tails low high =
            if low < high then
                let
                    middle =
                        (low + high) // 2
                in
                if rankAt (Array.get middle tails |> Maybe.withDefault 0) < rank then
                    search rank tails (middle + 1) high

                else
                    search rank tails low middle

            else
                low

        extend index ( _, maybeRank ) ( tails, previous ) =
            case maybeRank of
                Nothing ->
                    ( tails, previous )

                Just rank ->
                    let
                        position =
                            search rank tails 0 (Array.length tails)

                        withPrevious =
                            if position > 0 then
                                Dict.insert index (Array.get (position - 1) tails |> Maybe.withDefault 0) previous

                            else
                                previous

                        withTail =
                            if position == Array.length tails then
                                Array.push index tails

                            else
                                Array.set position index tails
                    in
                    ( withTail, withPrevious )

        ( finalTails, finalPrevious ) =
            items
                |> Array.toIndexedList
                |> List.foldl (\( index, item ) state -> extend index item state) ( Array.empty, Dict.empty )

        walk maybeIndex acc =
            case maybeIndex of
                Just index ->
                    walk (Dict.get index finalPrevious) (Set.insert index acc)

                Nothing ->
                    acc
    in
    walk (Array.get (Array.length finalTails - 1) finalTails) Set.empty
