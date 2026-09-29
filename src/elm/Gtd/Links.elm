module Gtd.Links exposing (Segment(..), segments, view)

{-| Links written in an Action's title: web addresses, Markdown links
`[text](https://…)` and `[[note]]` links, shown as links and opened by the host.

Only `http` and `https` addresses become links. A Markdown link also shows where
it goes, since a title can come from an email subject and a sender chooses the
text of a link as easily as its address.

-}

import Html exposing (Html, a, span, text)
import Html.Attributes exposing (class, href)
import Html.Events exposing (custom)
import Json.Decode as Decode


type Segment
    = Plain String
      -- What the title shows, the address, and whether the text differs from it.
    | Web { label : String, url : String, labelled : Bool }
      -- What the title shows and the link text Obsidian resolves.
    | Note { label : String, target : String }


type alias Config msg =
    { openUrl : String -> msg
    , openNote : String -> msg
    }


view : Config msg -> String -> List (Html msg)
view config title =
    List.concatMap (segmentView config) (segments title)


segmentView : Config msg -> Segment -> List (Html msg)
segmentView config segment =
    case segment of
        Plain plain ->
            [ text plain ]

        Web link ->
            a [ class "dg-title-link", href link.url, onLinkClick (config.openUrl link.url) ] [ text link.label ]
                :: (if link.labelled then
                        [ span [ class "dg-title-link-host" ] [ text (" (" ++ host link.url ++ ")") ] ]

                    else
                        []
                   )

        Note link ->
            [ a [ class "dg-title-link", href link.target, onLinkClick (config.openNote link.target) ] [ text link.label ] ]


{-| The link is the host's to open; the card or row around it doesn't hear the click.
-}
onLinkClick : msg -> Html.Attribute msg
onLinkClick msg =
    custom "click" (Decode.succeed { message = msg, stopPropagation = True, preventDefault = True })



-- PARSING


segments : String -> List Segment
segments title =
    case nextLink title of
        Just ( before, link, rest ) ->
            (if String.isEmpty before then
                []

             else
                [ Plain before ]
            )
                ++ link
                :: segments rest

        Nothing ->
            if String.isEmpty title then
                []

            else
                [ Plain title ]


{-| The earliest link in the text: the text before it, the link, and the text after.
-}
nextLink : String -> Maybe ( String, Segment, String )
nextLink title =
    [ noteLink title, markdownLink title, bareLink title ]
        |> List.filterMap identity
        |> List.sortBy (\( start, _, _ ) -> start)
        |> List.head
        |> Maybe.map (\( start, link, end ) -> ( String.left start title, link, String.dropLeft end title ))


{-| `[[target]]` or `[[target|shown]]`, as start, link and end offsets.
-}
noteLink : String -> Maybe ( Int, Segment, Int )
noteLink title =
    firstIndex "[[" title
        |> Maybe.andThen
            (\start ->
                indexFrom (start + 2) "]]" title
                    |> Maybe.andThen
                        (\close ->
                            let
                                inner =
                                    String.slice (start + 2) close title

                                ( target, label ) =
                                    case String.split "|" inner of
                                        first :: shown :: _ ->
                                            ( String.trim first, String.trim shown )

                                        _ ->
                                            ( String.trim inner, String.trim inner )
                            in
                            if String.isEmpty target || String.contains "[" inner then
                                Nothing

                            else
                                Just ( start, Note { label = label, target = target }, close + 2 )
                        )
            )


{-| `[text](https://…)`, the first one whose address is a web address.
-}
markdownLink : String -> Maybe ( Int, Segment, Int )
markdownLink title =
    String.indexes "[" title
        |> List.filterMap
            (\start ->
                if String.slice start (start + 2) title == "[[" || (start > 0 && String.slice (start - 1) start title == "[") then
                    Nothing

                else
                    indexFrom (start + 1) "](" title
                        |> Maybe.andThen
                            (\middle ->
                                indexFrom (middle + 2) ")" title
                                    |> Maybe.andThen
                                        (\close ->
                                            let
                                                label =
                                                    String.slice (start + 1) middle title

                                                url =
                                                    String.trim (String.slice (middle + 2) close title)
                                            in
                                            if isWeb url && not (String.isEmpty (String.trim label)) && not (String.contains "]" label) then
                                                Just ( start, Web { label = label, url = url, labelled = True }, close + 1 )

                                            else
                                                Nothing
                                        )
                            )
            )
        |> List.head


{-| A web address written out, up to the next space, without trailing punctuation.
-}
bareLink : String -> Maybe ( Int, Segment, Int )
bareLink title =
    [ firstIndex "https://" title, firstIndex "http://" title ]
        |> List.filterMap identity
        |> List.minimum
        |> Maybe.andThen
            (\start ->
                let
                    word =
                        String.dropLeft start title |> String.words |> List.head |> Maybe.withDefault ""

                    url =
                        trimTrailing word
                in
                if String.length url <= String.length "https://" then
                    Nothing

                else
                    Just ( start, Web { label = shorten url, url = url, labelled = False }, start + String.length url )
            )


trimTrailing : String -> String
trimTrailing url =
    if List.any (\ending -> String.endsWith ending url) [ ".", ",", ";", ":", "!", "?", ")", "]", "\"", "'" ] then
        trimTrailing (String.dropRight 1 url)

    else
        url


{-| An address as a title shows it: without the scheme, and cut short when long.
-}
shorten : String -> String
shorten url =
    let
        bare =
            url |> dropPrefix "https://" |> dropPrefix "http://" |> dropPrefix "www."
    in
    if String.length bare > 40 then
        String.left 39 bare ++ "…"

    else
        bare


host : String -> String
host url =
    url
        |> dropPrefix "https://"
        |> dropPrefix "http://"
        |> String.split "/"
        |> List.head
        |> Maybe.withDefault url


isWeb : String -> Bool
isWeb url =
    (String.startsWith "https://" url || String.startsWith "http://" url) && not (String.contains " " url)


dropPrefix : String -> String -> String
dropPrefix prefix value =
    if String.startsWith prefix value then
        String.dropLeft (String.length prefix) value

    else
        value


firstIndex : String -> String -> Maybe Int
firstIndex needle haystack =
    String.indexes needle haystack |> List.head


indexFrom : Int -> String -> String -> Maybe Int
indexFrom offset needle haystack =
    String.indexes needle haystack |> List.filter (\index -> index >= offset) |> List.head
